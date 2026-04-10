// Game.js - Client benötigt keine Spiel-Logik mehr
// Der Server steuert alles über Socket-Events

// Diese Funktionen sind für Legacy-Kompatibilität da, sollten aber nicht aufgerufen werden
function assignRoles() {
    console.warn("assignRoles() wird vom Server durchgeführt");
}

function nextPhase() {
    console.warn("nextPhase() sollte nicht aufgerufen werden - verwende nextPhaseServer()");
}

function checkGameOver() {
    console.warn("checkGameOver() wird vom Server durchgeführt");
}

function killPlayer(name) {
    console.warn("killPlayer() wird vom Server durchgeführt");
}

function resolveWerewolfVotes() {
    console.warn("resolveWerewolfVotes() wird vom Server durchgeführt");
}

function voteWerewolf(target) {
    console.warn("voteWerewolf() wird vom Server durchgeführt");
}

function votePlayer(target) {
    console.warn("votePlayer() wird vom Server durchgeführt");
}

function resolveVotes() {
    console.warn("resolveVotes() wird vom Server durchgeführt");
}