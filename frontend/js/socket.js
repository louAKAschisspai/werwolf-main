// --- Socket.io Verbindung ---
let socket = null;
let currentRoomId = null;
let currentPlayerName = null;

// Private Daten für Sonderrollen (nur für den jeweiligen Spieler sichtbar)
let witchNightVictim = null;   // Opfer der Werwölfe (nur für Hexe)
let seerRevealResult = null;   // Inspektionsergebnis (nur für Seherin)
let werewolfChatHistory = [];  // In-Memory Wolf-Chat für aktuelle Sitzung

function initSocket() {
    socket = io({ transports: ['websocket'] });

    socket.on('connect', () => {
        console.log('Mit Server verbunden');
        const savedRoom = sessionStorage.getItem('werwolf_roomId');
        const savedName = sessionStorage.getItem('werwolf_playerName');
        if (savedRoom && savedName) {
            currentRoomId    = savedRoom;
            currentPlayerName = savedName;
            console.log(`Rejoining ${savedRoom} als ${savedName}`);
            socket.emit('joinRoom', savedRoom, savedName);
        }
    });

    socket.on('playerJoined', (data) => {
        gameState.players = data.players.map(p => ({
            name: p.name,
            role: p.role,
            alive: p.alive
        }));
        if (data.leaderName) gameState.leaderName = data.leaderName;
        updateUI();
    });

    socket.on('playerLeft', (data) => {
        console.log('Spieler verlassen');
        gameState.players = data.players.map(p => ({
            name: p.name,
            role: p.role,
            alive: p.alive
        }));
        if (data.leaderName) gameState.leaderName = data.leaderName;
        updateUI();
    });

    socket.on('gameStateUpdated', (data) => {
        // Chat leeren wenn Lobby-Phase beginnt (egal woher)
        if (data.gameState.phase === 'lobby' && gameState.phase !== 'lobby') {
            clearChatMessages();
        }
        // Private Rollendaten zurücksetzen wenn Nacht-Phase beginnt
        if (data.gameState.phase === 'night') {
            witchNightVictim = null;
            seerRevealResult = null;
        }
        Object.assign(gameState, data.gameState);
        updateUI();
    });

    socket.on('chatMessage', (data) => {
        appendChatMessage(data.name, data.message, data.system);
    });

    socket.on('chatHistory', (history) => {
        clearChatMessages();
        history.forEach(msg => appendChatMessage(msg.name, msg.message, msg.system));
    });

    // Private Event: nur die Hexe empfängt dies
    socket.on('witchInfo', (data) => {
        witchNightVictim = data.victim;
        updateUI();
    });

    // Private Event: nur die Seherin empfängt dies
    socket.on('seerResult', (data) => {
        seerRevealResult = data; // { player, role }
        updateUI();
    });

    // Privater Werwolf-Chat (nur für Wölfe sichtbar)
    socket.on('werewolfChat', (data) => {
        appendWerewolfMessage(data.name, data.message);
    });

    // Wolf-Chat-Historie bei Reconnect (nur Wölfe empfangen das)
    socket.on('werewolfChatHistory', (history) => {
        werewolfChatHistory = [];
        const box = document.getElementById('werewolfChatMessages');
        if (box) box.innerHTML = '';
        history.forEach(msg => appendWerewolfMessage(msg.name, msg.message));
    });

    socket.on('disconnect', () => {
        console.log('Von Server getrennt');
    });
}

function joinRoom(roomId, playerName) {
    if (!socket) initSocket();
    currentRoomId = roomId;
    currentPlayerName = playerName;
    sessionStorage.setItem('werwolf_roomId', roomId);
    sessionStorage.setItem('werwolf_playerName', playerName);
    socket.emit('joinRoom', roomId, playerName);
}

function startGame(numWerewolves) {
    if (!socket) {
        alert('Fehler: Nicht mit Server verbunden. Seite neu laden!');
        return;
    }
    if (!currentRoomId) {
        alert('Fehler: Raum-ID nicht gesetzt!');
        return;
    }
    socket.emit('startGame', currentRoomId, numWerewolves);
}

function nextPhaseServer() {
    if (socket && currentRoomId) {
        socket.emit('nextPhase', currentRoomId);
    }
}

function sendVote(target) {
    if (socket && currentRoomId) {
        socket.emit('playerVote', currentRoomId, target);
    }
}

function sendWitchAction(heal, poisonTarget) {
    if (socket && currentRoomId) {
        socket.emit('witchAction', currentRoomId, { heal: !!heal, poisonTarget: poisonTarget || null });
        witchNightVictim = null;
    }
}

function sendSeerAction(target) {
    if (socket && currentRoomId) {
        socket.emit('seerAction', currentRoomId, target);
    }
}

function sendWerewolfChat(message) {
    if (socket && currentRoomId && message.trim()) {
        socket.emit('werewolfChat', currentRoomId, message.trim());
    }
}

function sendLobbySettings(numWerewolves, activeRoles) {
    if (socket && currentRoomId) {
        socket.emit('lobbySettings', currentRoomId, { numWerewolves, activeRoles });
    }
}

function leaveRoom() {
    if (socket && currentRoomId && currentPlayerName) {
        socket.emit('leaveRoom', currentRoomId, currentPlayerName);
    }
    currentRoomId = null;
    currentPlayerName = null;
    witchNightVictim = null;
    seerRevealResult = null;
    werewolfChatHistory = [];
    sessionStorage.removeItem('werwolf_roomId');
    sessionStorage.removeItem('werwolf_playerName');
    Object.assign(gameState, {
        phase: 'lobby', round: 1, gameOver: false, players: [],
        votes: {}, numWerewolves: 1, currentVoters: [], currentVoterIndex: 0,
        werewolfVotes: {}, votingRound: 1, isWerewolfVoting: false,
        killedInNight: null, votingResult: null, isFirstDay: true,
        afterNight: false, announcement: '', leaderName: null,
        activeRoles: { witch: false, seer: false },
        witchHealUsed: false, witchPoisonUsed: false, nightVictim: null,
    });
}

function returnToLobby() {
    if (socket && currentRoomId) {
        socket.emit('returnToLobby', currentRoomId);
    }
}

function sendChat(message) {
    if (socket && currentRoomId && message.trim()) {
        socket.emit('chatMessage', currentRoomId, message.trim());
    }
}

// Socket am Anfang initialisieren
initSocket();
