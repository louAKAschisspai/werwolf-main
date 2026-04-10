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
    votingRound: 1,
    isWerewolfVoting: false,
    killedInNight: null,
    votingResult: null,
    isFirstDay: true,
    afterNight: false,
    announcement: ""
};