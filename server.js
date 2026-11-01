'use strict';

var http = require('http');
var crypto = require('crypto');
var WebSocket = require('ws');
var Pool = require('pg').Pool;

var port = Number(process.env.PORT) || 3000;
var maxPlayers = Number(process.env.MAX_PLAYERS) || 20;
var lobbyPassword = process.env.LOBBY_PASSWORD || '';
var databaseUrl = process.env.DATABASE_URL || '';
var adminUsername = String(process.env.ADMIN_USERNAME || '').trim();
var adminUsernameKey = adminUsername.toLowerCase();
var adminBootstrapSecret = process.env.ADMIN_BOOTSTRAP_SECRET || '';
var players = new Map();
var authenticationAttempts = new Map();
var pool;

if (lobbyPassword.length < 16) {
    throw new Error('Set LOBBY_PASSWORD to a shared code of at least 16 characters.');
}
if (!databaseUrl) {
    throw new Error('Set DATABASE_URL to a durable PostgreSQL database before starting the server.');
}
if (!/^[A-Za-z0-9_]{3,24}$/.test(adminUsername) || adminBootstrapSecret.length < 32) {
    throw new Error('Set ADMIN_USERNAME and an ADMIN_BOOTSTRAP_SECRET of at least 32 characters.');
}
if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
    throw new Error('MAX_PLAYERS must be a positive integer.');
}

pool = new Pool({ connectionString: databaseUrl });
pool.on('error', function(error) {
    console.error('[Multiplayer] Database pool error:', error.message);
});

var httpServer = http.createServer(function(request, response) {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('RPG Maker MV multiplayer server is running.\n');
});

var webSocketServer = new WebSocket.Server({
    server: httpServer,
    maxPayload: 4096
});

function broadcast(payload) {
    var message = JSON.stringify(payload);
    webSocketServer.clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function sendToSocket(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function sendAuthenticationError(socket, code, text) {
    sendToSocket(socket, {
        type: 'auth_error',
        code: code,
        text: text
    });
    setTimeout(function() {
        if (socket.readyState === WebSocket.OPEN) {
            socket.close(1008, code);
        }
    }, 50);
}

function playerList() {
    return Array.from(players.values()).map(function(player) {
        return {
            id: player.id,
            name: player.name,
            characterName: player.characterName,
            characterIndex: player.characterIndex,
            mapId: player.mapId,
            x: player.x,
            y: player.y,
            direction: player.direction,
            visible: player.visible
        };
    });
}

function broadcastPlayers() {
    broadcast({ type: 'players', players: playerList() });
}

function boundedString(value, maximum, fallback) {
    if (typeof value !== 'string') {
        return fallback;
    }
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum) || fallback;
}

function validCoordinate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000;
}

function validUsername(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_]{3,24}$/.test(value);
}

function sanitizeCharacterInfo(value) {
    if (value === null) {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    var sections = Object.keys(value);
    if (sections.length > 32) {
        return undefined;
    }

    var result = {};
    for (var i = 0; i < sections.length; i++) {
        var section = sections[i];
        var piece = value[section];
        if (!section || section.length > 64 || /[\u0000-\u001f\u007f]/.test(section) ||
                section === '__proto__' || section === 'constructor' || section === 'prototype' ||
                !piece || typeof piece !== 'object' || Array.isArray(piece) ||
                typeof piece.path !== 'string' ||
                piece.path.indexOf('..') !== -1 ||
                !/^img\/SumRndmDde\/character-creator-ex\/[A-Za-z0-9 _.-]{1,64}\/walk\/$/.test(piece.path) ||
                typeof piece.file !== 'string' || piece.file.length > 128 ||
                !piece.file || /[\\/\u0000-\u001f\u007f]/.test(piece.file) ||
                !Array.isArray(piece.color) || piece.color.length > 5 ||
                !piece.color.every(function(color) {
                    return typeof color === 'number' && Number.isFinite(color) &&
                        Math.abs(color) <= 1000;
                })) {
            return undefined;
        }
        result[section] = {
            path: piece.path,
            file: piece.file,
            color: piece.color
        };
    }
    if (JSON.stringify(result).length > 3500) {
        return undefined;
    }
    return result;
}

function secretsMatch(candidate, expected) {
    if (typeof candidate !== 'string') {
        return false;
    }
    var expectedHash = crypto.createHash('sha256').update(expected).digest();
    var candidateHash = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function derivePassword(password, salt) {
    return new Promise(function(resolve, reject) {
        crypto.scrypt(password, salt, 64, {
            N: 16384,
            r: 8,
            p: 1,
            maxmem: 64 * 1024 * 1024
        }, function(error, key) {
            if (error) {
                reject(error);
            } else {
                resolve(key);
            }
        });
    });
}

function authenticationAddress(socket) {
    return socket._socket && socket._socket.remoteAddress || 'unknown';
}

function isRateLimited(address) {
    var attempts = authenticationAttempts.get(address);
    if (!attempts) {
        return false;
    }
    if (Date.now() - attempts.startedAt >= 15 * 60 * 1000) {
        authenticationAttempts.delete(address);
        return false;
    }
    return attempts.count >= 8;
}

function recordAuthenticationFailure(address) {
    var attempts = authenticationAttempts.get(address);
    if (!attempts || Date.now() - attempts.startedAt >= 15 * 60 * 1000) {
        authenticationAttempts.set(address, { startedAt: Date.now(), count: 1 });
    } else {
        attempts.count++;
    }
}

function updatePosition(player, message) {
    var mapId = Number(message.mapId);
    var characterIndex = Number(message.characterIndex);
    var direction = Number(message.direction);
    if (!Number.isInteger(mapId) || mapId < 1 ||
            !validCoordinate(message.x) || !validCoordinate(message.y) ||
            [2, 4, 6, 8].indexOf(direction) === -1 ||
            !Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex > 7) {
        return false;
    }
    player.characterName = boundedString(message.characterName, 50, '');
    player.characterIndex = characterIndex;
    player.mapId = mapId;
    player.x = message.x;
    player.y = message.y;
    player.direction = direction;
    player.visible = message.visible !== false;
    return true;
}

function closeUserConnections(userId, code, reason) {
    players.forEach(function(player, socket) {
        if (player.userId === userId && socket.readyState === WebSocket.OPEN) {
            socket.close(code, reason);
        }
    });
}

function findOnlineUser(usernameKey) {
    var online = null;
    players.forEach(function(player, socket) {
        if (!online && player.usernameKey === usernameKey && socket.readyState === WebSocket.OPEN) {
            online = { player: player, socket: socket };
        }
    });
    return online;
}

function sendAdminResult(socket, text) {
    sendToSocket(socket, { type: 'admin_result', text: text });
}

function sendUserNotice(usernameKey, text) {
    players.forEach(function(player, socket) {
        if (player.usernameKey === usernameKey) {
            sendToSocket(socket, { type: 'admin_notice', text: text });
        }
    });
}

function parseDuration(value) {
    if (value === undefined) {
        return { valid: true, until: null, label: 'permanente' };
    }
    var minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) {
        return { valid: false };
    }
    return {
        valid: true,
        until: new Date(Date.now() + minutes * 60 * 1000),
        label: minutes + ' minuti'
    };
}

async function findAccountForCommand(username) {
    if (!validUsername(username)) {
        return null;
    }
    var result = await pool.query(
        'SELECT id::text AS id, username, username_key, is_admin FROM multiplayer_users WHERE username_key = $1',
        [username.toLowerCase()]
    );
    return result.rows[0] || null;
}

async function handleAdminCommand(socket, player, text) {
    if (!player.isAdmin) {
        sendAdminResult(socket, 'Comando riservato agli amministratori.');
        return;
    }

    var parts = text.trim().split(/\s+/);
    var command = parts[0].toLowerCase();
    var targetName = parts[1] || '';
    var targetKey = targetName.toLowerCase();
    if (command === '!help') {
        sendAdminResult(socket, '!kick nome | !ban nome [minuti] | !unban nome | ' +
            '!mute nome [minuti] | !unmute nome | !item nome id quantita | ' +
            '!weapon nome id quantita | !armor nome id quantita | !actor nome id | !unactor nome id');
        return;
    }

    if (['!kick', '!ban', '!unban', '!mute', '!unmute',
            '!item', '!weapon', '!armor', '!actor', '!unactor'].indexOf(command) === -1) {
        sendAdminResult(socket, 'Comando sconosciuto. Usa !help.');
        return;
    }
    if (!validUsername(targetName)) {
        sendAdminResult(socket, 'Specifica un nome utente valido.');
        return;
    }

    var target;
    try {
        target = await findAccountForCommand(targetName);
    } catch (error) {
        console.error('[Multiplayer] Could not look up admin command target:', error.message);
        sendAdminResult(socket, 'Errore del database; comando non eseguito.');
        return;
    }
    if (!target) {
        sendAdminResult(socket, 'Account non trovato: ' + targetName + '.');
        return;
    }
    if (target.is_admin) {
        sendAdminResult(socket, 'Non puoi applicare comandi admin a un amministratore.');
        return;
    }

    var duration;
    var online;
    if (command === '!ban' || command === '!mute') {
        duration = parseDuration(parts[2]);
        if (!duration.valid || parts.length > 3) {
            sendAdminResult(socket, 'Durata non valida. Usa minuti da 1 a 525600, oppure omettili per un effetto permanente.');
            return;
        }
    }

    try {
        if (command === '!kick') {
            if (parts.length !== 2) {
                sendAdminResult(socket, 'Sintassi: !kick nome');
                return;
            }
            online = findOnlineUser(targetKey);
            if (!online) {
                sendAdminResult(socket, target.username + ' non è online.');
                return;
            }
            online.socket.close(4001, 'Rimosso da un amministratore');
            sendAdminResult(socket, target.username + ' espulso.');
            return;
        }
        if (command === '!ban') {
            await pool.query(
                'UPDATE multiplayer_users SET is_banned = TRUE, ban_until = $2 WHERE id = $1',
                [target.id, duration.until]
            );
            closeUserConnections(target.id, 4002, 'Account bannato');
            sendAdminResult(socket, target.username + ' bannato (' + duration.label + ').');
            return;
        }
        if (command === '!unban') {
            if (parts.length !== 2) {
                sendAdminResult(socket, 'Sintassi: !unban nome');
                return;
            }
            await pool.query(
                'UPDATE multiplayer_users SET is_banned = FALSE, ban_until = NULL WHERE id = $1',
                [target.id]
            );
            sendAdminResult(socket, 'Ban rimosso per ' + target.username + '.');
            return;
        }
        if (command === '!mute') {
            await pool.query(
                'UPDATE multiplayer_users SET is_muted = TRUE, mute_until = $2 WHERE id = $1',
                [target.id, duration.until]
            );
            players.forEach(function(activePlayer) {
                if (activePlayer.userId === target.id) {
                    activePlayer.isMuted = true;
                    activePlayer.mutedUntil = duration.until;
                }
            });
            sendUserNotice(targetKey, 'Sei stato silenziato (' + duration.label + ').');
            sendAdminResult(socket, target.username + ' silenziato (' + duration.label + ').');
            return;
        }
        if (command === '!unmute') {
            if (parts.length !== 2) {
                sendAdminResult(socket, 'Sintassi: !unmute nome');
                return;
            }
            await pool.query(
                'UPDATE multiplayer_users SET is_muted = FALSE, mute_until = NULL WHERE id = $1',
                [target.id]
            );
            players.forEach(function(activePlayer) {
                if (activePlayer.userId === target.id) {
                    activePlayer.isMuted = false;
                    activePlayer.mutedUntil = null;
                }
            });
            sendUserNotice(targetKey, 'Il silenziamento è stato rimosso.');
            sendAdminResult(socket, 'Silenziamento rimosso per ' + target.username + '.');
            return;
        }

        online = findOnlineUser(targetKey);
        if (!online) {
            sendAdminResult(socket, target.username + ' deve essere online per ricevere questo comando.');
            return;
        }

        var id = Number(parts[2]);
        if (!Number.isInteger(id) || id < 1 || id > 9999) {
            sendAdminResult(socket, 'ID non valido.');
            return;
        }
        var action;
        var payload = { type: 'admin_action', id: id };
        if (command === '!item' || command === '!weapon' || command === '!armor') {
            var amount = Number(parts[3]);
            if (!Number.isInteger(amount) || amount < 1 || amount > 99 || parts.length !== 4) {
                sendAdminResult(socket, 'Quantità non valida. Usa un valore da 1 a 99.');
                return;
            }
            action = command === '!item' ? 'item' : command === '!weapon' ? 'weapon' : 'armor';
            payload.action = 'grant_item';
            payload.itemType = action;
            payload.amount = amount;
        } else {
            if (parts.length !== 3) {
                sendAdminResult(socket, 'Sintassi: ' + command + ' nome id');
                return;
            }
            payload.action = command === '!actor' ? 'add_actor' : 'remove_actor';
        }
        sendToSocket(online.socket, payload);
        sendAdminResult(socket, 'Comando inviato a ' + target.username + '.');
    } catch (error) {
        console.error('[Multiplayer] Admin command failed:', error.message);
        sendAdminResult(socket, 'Errore durante l’esecuzione del comando.');
    }
}

async function authenticateSocket(socket, message, context) {
    var username = typeof message.username === 'string' ? message.username.trim() : '';
    var attemptKey = context.address + '|' +
        (validUsername(username) ? username.toLowerCase() : 'invalid');
    if (isRateLimited(attemptKey)) {
        sendAuthenticationError(socket, 'rate_limited', 'Troppi tentativi. Riprova tra 15 minuti.');
        return;
    }
    if (!secretsMatch(message.lobbyPassword, lobbyPassword)) {
        recordAuthenticationFailure(attemptKey);
        sendAuthenticationError(socket, 'invalid_login', 'Codice lobby non valido.');
        return;
    }

    var mode = message.mode;
    if (!validUsername(username) || typeof message.password !== 'string' ||
            message.password.length < 12 || message.password.length > 128) {
        recordAuthenticationFailure(attemptKey);
        sendAuthenticationError(socket, 'invalid_input',
            'Nome: 3-24 lettere, numeri o _. Password: almeno 12 caratteri.');
        return;
    }
    var usernameKey = username.toLowerCase();
    var account;

    try {
        if (mode === 'register') {
            var isAdmin = usernameKey === adminUsernameKey;
            if (isAdmin && !secretsMatch(message.adminBootstrapSecret, adminBootstrapSecret)) {
                recordAuthenticationFailure(attemptKey);
                sendAuthenticationError(socket, 'admin_setup_required',
                    'Per registrare l’account amministratore serve la chiave di setup.');
                return;
            }
            var salt = crypto.randomBytes(16);
            var passwordHash = await derivePassword(message.password, salt);
            var inserted = await pool.query(
                'INSERT INTO multiplayer_users ' +
                '(username, username_key, password_salt, password_hash, is_admin) ' +
                'VALUES ($1, $2, $3, $4, $5) ' +
                'RETURNING id::text AS id, username, username_key, is_admin, appearance, is_banned, ' +
                'ban_until, is_muted, mute_until',
                [username, usernameKey, salt, passwordHash, isAdmin]
            );
            account = inserted.rows[0];
        } else if (mode === 'login') {
            var result = await pool.query(
                'SELECT id::text AS id, username, username_key, password_salt, password_hash, ' +
                'is_admin, appearance, is_banned, ban_until, is_muted, mute_until ' +
                'FROM multiplayer_users WHERE username_key = $1',
                [usernameKey]
            );
            account = result.rows[0];
            if (!account) {
                recordAuthenticationFailure(attemptKey);
                sendAuthenticationError(socket, 'invalid_login', 'Nome o password non validi.');
                return;
            }
            var candidateHash = await derivePassword(message.password, account.password_salt);
            if (!crypto.timingSafeEqual(candidateHash, account.password_hash)) {
                recordAuthenticationFailure(attemptKey);
                sendAuthenticationError(socket, 'invalid_login', 'Nome o password non validi.');
                return;
            }
        } else {
            sendAuthenticationError(socket, 'invalid_input', 'Seleziona registrazione o accesso.');
            return;
        }
    } catch (error) {
        if (mode === 'register' && error.code === '23505') {
            sendAuthenticationError(socket, 'username_taken', 'Questo nome è già registrato.');
            return;
        }
        console.error('[Multiplayer] Account authentication failed:', error.message);
        sendAuthenticationError(socket, 'server_error', 'Accesso non disponibile. Riprova più tardi.');
        return;
    }

    if (account.is_banned) {
        var banExpiry = account.ban_until ? new Date(account.ban_until) : null;
        if (!banExpiry || banExpiry.getTime() > Date.now()) {
            var banMessage = banExpiry ? 'Account bannato fino al ' + banExpiry.toLocaleString('it-IT') + '.' :
                'Account bannato permanentemente.';
            sendAuthenticationError(socket, 'banned', banMessage);
            return;
        }
        await pool.query(
            'UPDATE multiplayer_users SET is_banned = FALSE, ban_until = NULL WHERE id = $1',
            [account.id]
        );
        account.is_banned = false;
        account.ban_until = null;
    }

    if (players.size >= maxPlayers) {
        sendAuthenticationError(socket, 'lobby_full', 'Lobby piena. Riprova tra qualche minuto.');
        return;
    }
    clearTimeout(context.authenticationTimer);
    context.authenticated = true;
    context.player = {
        id: crypto.randomBytes(16).toString('hex'),
        userId: account.id,
        usernameKey: account.username_key,
        name: account.username,
        isAdmin: account.is_admin,
        isMuted: account.is_muted,
        mutedUntil: account.mute_until,
        characterName: '',
        characterIndex: 0,
        characterInfo: sanitizeCharacterInfo(account.appearance) || null,
        mapId: 0,
        x: 0,
        y: 0,
        direction: 2,
        visible: false,
        lastChatAt: 0
    };
    players.set(socket, context.player);
    authenticationAttempts.delete(attemptKey);
    sendToSocket(socket, {
        type: 'welcome',
        id: context.player.id,
        name: account.username,
        isAdmin: account.is_admin,
        characterInfo: context.player.characterInfo
    });
    broadcastPlayers();
    players.forEach(function(existingPlayer, existingSocket) {
        if (existingSocket !== socket) {
            sendToSocket(socket, {
                type: 'appearance',
                id: existingPlayer.id,
                characterInfo: existingPlayer.characterInfo
            });
            sendToSocket(existingSocket, {
                type: 'appearance',
                id: context.player.id,
                characterInfo: context.player.characterInfo
            });
        }
    });
}

async function handleMessage(socket, context, message) {
    if (!context.authenticated) {
        if (context.authenticating || message.type !== 'auth') {
            socket.close(1008, 'Authentication required');
            return;
        }
        context.authenticating = true;
        try {
            await authenticateSocket(socket, message, context);
        } catch (error) {
            console.error('[Multiplayer] Authentication request failed:', error.message);
            sendAuthenticationError(socket, 'server_error', 'Accesso non disponibile. Riprova più tardi.');
        }
        return;
    }

    var player = context.player;
    if (message.type === 'position') {
        if (updatePosition(player, message)) {
            broadcastPlayers();
        }
    } else if (message.type === 'appearance') {
        var characterInfo = sanitizeCharacterInfo(message.characterInfo);
        if (characterInfo !== undefined &&
                JSON.stringify(characterInfo) !== JSON.stringify(player.characterInfo)) {
            try {
                await pool.query(
                    'UPDATE multiplayer_users SET appearance = $2::jsonb WHERE id = $1',
                    [player.userId, characterInfo === null ? null : JSON.stringify(characterInfo)]
                );
                player.characterInfo = characterInfo;
                broadcast({
                    type: 'appearance',
                    id: player.id,
                    characterInfo: player.characterInfo
                });
            } catch (error) {
                console.error('[Multiplayer] Could not persist player appearance:', error.message);
                sendToSocket(socket, {
                    type: 'admin_notice',
                    text: 'Impossibile salvare l’aspetto sul server.'
                });
            }
        }
    } else if (message.type === 'visibility') {
        player.visible = message.visible === true;
        broadcastPlayers();
    } else if (message.type === 'chat') {
        var text = boundedString(message.text, 300, '');
        var now = Date.now();
        var muteExpiry = player.mutedUntil ? new Date(player.mutedUntil).getTime() : null;
        if (player.isMuted && muteExpiry && muteExpiry <= now) {
            await pool.query(
                'UPDATE multiplayer_users SET is_muted = FALSE, mute_until = NULL WHERE id = $1',
                [player.userId]
            );
            player.isMuted = false;
            player.mutedUntil = null;
        }
        if (player.isMuted) {
            if (now - player.lastChatAt >= 750) {
                player.lastChatAt = now;
                sendUserNotice(player.usernameKey, 'Non puoi inviare messaggi: sei silenziato.');
            }
        } else if (text && now - player.lastChatAt >= 750) {
            player.lastChatAt = now;
            broadcast({
                type: 'chat',
                name: player.name,
                text: text
            });
        }
    } else if (message.type === 'admin_command' && typeof message.text === 'string') {
        await handleAdminCommand(socket, player, boundedString(message.text, 300, ''));
    }
}

webSocketServer.on('connection', function(socket) {
    var context = {
        authenticated: false,
        authenticating: false,
        player: null,
        address: authenticationAddress(socket),
        authenticationTimer: setTimeout(function() {
            socket.close(1008, 'Authentication timeout');
        }, 30000)
    };
    sendToSocket(socket, {
        type: 'auth_required',
        adminUsername: adminUsername
    });

    socket.on('message', function(rawMessage) {
        var message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch (error) {
            socket.close(1007, 'Invalid JSON');
            return;
        }
        if (!message || typeof message.type !== 'string') {
            return;
        }
        handleMessage(socket, context, message).catch(function(error) {
            console.error('[Multiplayer] Message handling failed:', error.message);
            if (socket.readyState === WebSocket.OPEN) {
                sendToSocket(socket, {
                    type: 'admin_notice',
                    text: 'Errore durante la richiesta; riprova.'
                });
            }
        });
    });

    socket.on('close', function() {
        clearTimeout(context.authenticationTimer);
        if (context.authenticated) {
            players.delete(socket);
            broadcastPlayers();
        }
    });

    socket.on('error', function(error) {
        console.error('[Multiplayer] WebSocket error:', error.message);
    });
});

async function initializeDatabase() {
    await pool.query(
        'CREATE TABLE IF NOT EXISTS multiplayer_users (' +
        'id BIGSERIAL PRIMARY KEY, ' +
        'username VARCHAR(24) NOT NULL, ' +
        'username_key VARCHAR(24) NOT NULL UNIQUE, ' +
        'password_salt BYTEA NOT NULL, ' +
        'password_hash BYTEA NOT NULL, ' +
        'is_admin BOOLEAN NOT NULL DEFAULT FALSE, ' +
        'appearance JSONB, ' +
        'is_banned BOOLEAN NOT NULL DEFAULT FALSE, ' +
        'ban_until TIMESTAMPTZ, ' +
        'is_muted BOOLEAN NOT NULL DEFAULT FALSE, ' +
        'mute_until TIMESTAMPTZ, ' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
        ')'
    );
}

initializeDatabase().then(function() {
    httpServer.listen(port, '0.0.0.0', function() {
        console.log('RPG Maker MV multiplayer server listening on port ' + port);
    });
}).catch(function(error) {
    console.error('[Multiplayer] Could not initialize PostgreSQL:', error.message);
    process.exitCode = 1;
    pool.end().catch(function(closeError) {
        console.error('[Multiplayer] Could not close PostgreSQL pool:', closeError.message);
    });
});
