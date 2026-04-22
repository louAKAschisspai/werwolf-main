const gameState = {
    phase: "lobby",
    round: 1,
    gameOver: false,
    players: [],
    votes: {},
    numWerewolves: 1,
    currentVoters: [],
    currentVoterIndex: 0,
    werewolfVotes: {},
    hasVotedNames: [],      // Wer hat abgestimmt (ohne Ziel, für Countdown-Phase)
    votingRound: 1,
    isWerewolfVoting: false,
    killedInNight: null,
    votingResult: null,
    isFirstDay: true,
    afterNight: false,
    announcement: "",
    leaderName: null,
    activeRoles: { witch: false, seer: false, hunter: false, amor: false },
    witchHealUsed: false,
    witchPoisonUsed: false,
    nightVictim: null,
    votingDuration: 60,     // Abstimmungszeit in Sekunden (30/60/90)
    countdownEnd: null,     // Unix-Timestamp (ms) wann Countdown endet
    countdownDuration: 0,   // Gesamtdauer des laufenden Countdowns
    loverNames: [],         // Sichtbar nur für Verliebte (und bei Game Over)
    hunterRevengeUsed: false,
    afterHunterRevenge: null,
};
