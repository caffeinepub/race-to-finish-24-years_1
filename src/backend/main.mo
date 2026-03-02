actor {
  var numWins = 0;

  public shared ({ caller }) func recordWin() : async () {
    numWins += 1;
  };

  public query ({ caller }) func getWinCount() : async Nat {
    numWins;
  };
};
