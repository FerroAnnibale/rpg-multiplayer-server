'use strict';

var http = require('http');
var crypto = require('crypto');
var WebSocket = require('ws');

var port = Number(process.env.PORT) || 3000;
var maxPlayers = Number(process.env.MAX_PLAYERS) || 20;
var lobbyPassword = process.env.LOBBY_PASSWORD || '';
var players = new Map();

if (lobbyPassword.length < 16) {
    throw new Error('Set LOBBY_PASSWORD to a shared code of at least 16 characters.');
}

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

function passwordsMatch(candidate) {
    if (typeof candidate !== 'string') {
        return false;
    }
    var expectedHash = crypto.createHash('sha256').update(lobbyPassword).digest();
    var candidateHash = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(expectedHash, candidateHash);
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
    player.name = boundedString(message.name, 24, player.name);
    player.characterName = boundedString(message.characterName, 50, '');
    player.characterIndex = characterIndex;
    player.mapId = mapId;
    player.x = message.x;
    player.y = message.y;
    player.direction = direction;
    player.visible = message.visible !== false;
    return true;
}

webSocketServer.on('connection', function(socket) {
    var player = null;
    var authenticated = false;
    var authenticationTimer = setTimeout(function() {
        socket.close(1008, 'Authentication timeout');
    }, 10000);
    socket.send(JSON.stringify({ type: 'auth_required' }));

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

        if (!authenticated) {
            if (message.type !== 'auth') {
                socket.close(1008, 'Authentication required');
                return;
            }
            if (!passwordsMatch(message.password)) {
                socket.send(JSON.stringify({ type: 'auth_error' }), function() {
                    socket.close(1008, 'Invalid lobby password');
                });
                return;
            }
            if (players.size >= maxPlayers) {
                socket.close(1013, 'Lobby is full');
                return;
            }
            clearTimeout(authenticationTimer);
            authenticated = true;
            player = {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'Giocatore',
                characterName: '',
                characterIndex: 0,
                mapId: 0,
                x: 0,
                y: 0,
                direction: 2,
                visible: false,
                lastChatAt: 0
            };
            players.set(socket, player);
            socket.send(JSON.stringify({ type: 'welcome', id: player.id }));
            broadcastPlayers();
            return;
        }

        if (message.type === 'position') {
            if (updatePosition(player, message)) {
                broadcastPlayers();
            }
        } else if (message.type === 'visibility') {
            player.visible = message.visible === true;
            broadcastPlayers();
        } else if (message.type === 'chat') {
            var text = boundedString(message.text, 300, '');
            var now = Date.now();
            if (text && now - player.lastChatAt >= 750) {
                player.lastChatAt = now;
                broadcast({
                    type: 'chat',
                    name: player.name,
                    text: text
                });
            }
        }
    });

    socket.on('close', function() {
        clearTimeout(authenticationTimer);
        if (authenticated) {
            players.delete(socket);
            broadcastPlayers();
        }
    });

    socket.on('error', function(error) {
        console.error('[Multiplayer] WebSocket error:', error.message);
    });
});

httpServer.listen(port, '0.0.0.0', function() {
    console.log('RPG Maker MV multiplayer server listening on port ' + port);
});
