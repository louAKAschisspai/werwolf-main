// --- Rollen zuweisen ---
function assignRoles() {
    const shuffled = [...gameState.players].sort(() => Math.random() - 0.5);
    for (let i = 0; i < gameState.numWerewolves; i++) {
        shuffled[i].role = "werewolf";
    }
    for (let i = gameState.numWerewolves; i < shuffled.length; i++) {
        shuffled[i].role = "villager";
    }
    gameState.players = shuffled;
    // Setze Voter für Nacht
    gameState.currentVoters = gameState.players.filter(p => p.role === "werewolf" && p.alive);
}

function nextPhase() {

    if (gameState.gameOver) return; // 👈 STOP wenn Spiel vorbei

    if (gameState.phase === "lobby") {
        gameState.phase = "day";
        gameState.isFirstDay = true;
    }

    else if (gameState.phase === "night") {
        if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
            resolveWerewolfVotes();
            gameState.phase = "day";
            gameState.afterNight = true;
        }
    }

    else if (gameState.phase === "day") {
        if (gameState.isFirstDay) {
            gameState.isFirstDay = false;
            gameState.phase = "night";
            gameState.isWerewolfVoting = true;
            gameState.currentVoters = gameState.players.filter(p => p.role === "werewolf" && p.alive);
            gameState.currentVoterIndex = 0;
            gameState.werewolfVotes = {};
            gameState.votingRound = 1;
        } else if (gameState.afterNight) {
            gameState.afterNight = false;
            gameState.phase = "voting";
            gameState.isWerewolfVoting = false;
            gameState.currentVoters = gameState.players.filter(p => p.alive);
            gameState.currentVoterIndex = 0;
            gameState.votes = {};
        }
    }

    else if (gameState.phase === "voting") {
        if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
            resolveVotes();
            gameState.phase = "night";
            gameState.round++;
            gameState.votes = {};
            gameState.werewolfVotes = {};
            gameState.votingResult = null;
            // Setze für night
            gameState.isWerewolfVoting = true;
            gameState.currentVoters = gameState.players.filter(p => p.role === "werewolf" && p.alive);
            gameState.currentVoterIndex = 0;
            gameState.werewolfVotes = {};
            gameState.votingRound = 1;
            gameState.afterNight = false;
        }
    }

    updateUI();
}


// --- Game Over Check ---
function checkGameOver() {

    const wolves = gameState.players
        .filter(p => p.role === "werewolf" && p.alive).length;

    const villagers = gameState.players
        .filter(p => p.role === "villager" && p.alive).length;

    if (wolves === 0) {
        gameState.phase = "game_over";
        gameState.gameOver = true;
        alert("🎉 Dorfbewohner gewinnen!");
    }

    else if (wolves >= villagers) {
        gameState.phase = "game_over";
        gameState.gameOver = true;
        alert("🐺 Werwölfe gewinnen!");
    }
}


// --- Night Logic ---
function killPlayer(name) {
    const player = gameState.players.find(p => p.name === name);

    if (player && player.alive) {
        player.alive = false;
        checkGameOver(); // 👈 NEU
    }
}

function resolveWerewolfVotes() {
    const counts = {};
    Object.values(gameState.werewolfVotes).forEach(target => {
        counts[target] = (counts[target] || 0) + 1;
    });

    let maxVotes = 0;
    let killedPlayer = null;
    let ties = [];

    for (let player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            killedPlayer = player;
            ties = [player];
        } else if (counts[player] === maxVotes) {
            ties.push(player);
        }
    }

    if (ties.length === 1 && killedPlayer && killedPlayer !== "Niemanden") {
        killPlayer(killedPlayer);
        gameState.killedInNight = killedPlayer;
    } else if (ties.length === 1 && killedPlayer === "Niemanden") {
        gameState.killedInNight = "Niemand";
    } else if (gameState.votingRound === 1) {
        // Gleichstand, wiederhole
        gameState.votingRound = 2;
        gameState.werewolfVotes = {};
        gameState.currentVoterIndex = 0;
        alert("Gleichstand! Werwölfe stimmen erneut ab.");
        updateUI();
        return; // Nicht wechseln
    } else {
        // Immer noch Gleichstand, niemand getötet
        gameState.killedInNight = "Niemand";
    }
}


// --- Voting ---
function voteWerewolf(target) {
    const voter = gameState.currentVoters[gameState.currentVoterIndex];
    gameState.werewolfVotes[voter.name] = target;
    gameState.currentVoterIndex++;
    if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
        resolveWerewolfVotes();
    } else {
        updateUI();
    }
}

function votePlayer(target) {
    const voter = gameState.currentVoters[gameState.currentVoterIndex];
    gameState.votes[voter.name] = target;
    gameState.currentVoterIndex++;
    updateUI();
}

function resolveVotes() {

    const counts = {};

    Object.values(gameState.votes).forEach(target => {
        if (target !== "Niemanden") {
            counts[target] = (counts[target] || 0) + 1;
        }
    });

    let maxVotes = 0;
    let killedPlayer = null;
    let candidates = [];

    for (let player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            killedPlayer = player;
            candidates = [player];
        } else if (counts[player] === maxVotes) {
            candidates.push(player);
        }
    }

    if (killedPlayer && candidates.length === 1) {
        killPlayer(killedPlayer);
        gameState.votingResult = killedPlayer;
    } else {
        gameState.votingResult = "Niemand (Gleichstand)";
        alert("Gleichstand! Niemand wird getötet.");
    }

    checkGameOver(); 
}