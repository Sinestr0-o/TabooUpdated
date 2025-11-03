const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Server configuration
const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Load the word list
const WORDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8')
);

// Helper functions
function rng(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pointsFor({ diff }) {
  // Assign points based on difficulty
  if (diff === 'easy') return rng(5, 15);
  if (diff === 'medium') return rng(20, 35);
  return rng(40, 50);
}

function pickWord(excludeSet) {
  /**
   * Select a word not in excludeSet using weighted sampling:
   * 50% chance for easy, 35% for medium and 15% for hard.
   */
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = Math.random();
    let pool;
    if (r < 0.5) pool = WORDS.easy;
    else if (r < 0.85) pool = WORDS.medium;
    else pool = WORDS.hard;
    const w = pool[rng(0, pool.length - 1)];
    if (!excludeSet.has(w)) {
      const diff = WORDS.easy.includes(w)
        ? 'easy'
        : WORDS.medium.includes(w)
        ? 'medium'
        : 'hard';
      return { text: w, diff, points: pointsFor({ diff }) };
    }
  }
  // Fallback: find any unused word
  const all = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard];
  for (const w of all) {
    if (!excludeSet.has(w)) {
      const diff = WORDS.easy.includes(w)
        ? 'easy'
        : WORDS.medium.includes(w)
        ? 'medium'
        : 'hard';
      return { text: w, diff, points: pointsFor({ diff }) };
    }
  }
  // Last resort: return a random word
  const fallback = all[rng(0, all.length - 1)];
  const diff = WORDS.easy.includes(fallback)
    ? 'easy'
    : WORDS.medium.includes(fallback)
    ? 'medium'
    : 'hard';
  return { text: fallback, diff, points: pointsFor({ diff }) };
}

function makeBoard(count) {
  // Generate an initial board with a given number of words
  const set = new Set();
  const board = [];
  while (board.length < count) {
    const next = pickWord(set);
    set.add(next.text);
    board.push({ ...next, guessed: false });
  }
  return board;
}

// Game configuration
const EXPAND_AFTER = 7; // number of correct guesses before new words start adding
const MAX_BOARD_SIZE = 40; // maximum number of words on the board
const ROOM_TTL_MS = 120000; // how long to keep a room after everyone leaves (2 minutes)

// In-memory storage for all rooms
const rooms = new Map();

/**
 * Create a client-facing representation of the room for a particular viewer.
 * This hides the board when the viewer is not allowed to see it.
 */
function roomStateForClient(room, viewerId) {
  const player = room.players[viewerId];
  // Determine board visibility
  let boardVisible = true;
  if (room.inProgress && room.activeTeam) {
    const viewerTeam = player ? player.team : null;
    const isOp = player ? player.isOperator : false;
    if (viewerTeam === room.activeTeam && !isOp) {
      boardVisible = false;
    }
  }
  // Prepare a lightweight list of players
  const playersArr = Object.entries(room.players).map(([id, ply]) => ({
    id,
    name: ply.name,
    team: ply.team,
    isOperator: ply.isOperator,
  }));
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    roundsTotal: room.roundsTotal,
    currentRound: room.currentRound,
    inProgress: room.inProgress,
    activeTeam: room.activeTeam,
    timeRemaining: room.roundEndsAt
      ? Math.max(0, room.roundEndsAt - Date.now())
      : 0,
    boardVisible,
    board: room.board.map((t) => ({
      text: t.text,
      points: t.points,
      guessed: t.guessed,
    })),
    teams: {
      red: { score: room.teams.red.score },
      blue: { score: room.teams.blue.score },
    },
    players: playersArr,
  };
}

/**
 * Send the room state to each client in the room, personalized for their view.
 */
function broadcastRoom(room) {
  for (const id of Object.keys(room.players)) {
    io.to(id).emit('room:update', roomStateForClient(room, id));
  }
}

/**
 * Start a new round: resets counters, sets timer and notifies players.
 */
function startRound(room) {
  // Each round lasts 3 minutes
  const DURATION = 3 * 60 * 1000;
  room.roundEndsAt = Date.now() + DURATION;
  room.correctThisRound = 0;
  // Clear any existing timer
  if (room.timer) clearInterval(room.timer);
  // Tick every second to update timers
  room.timer = setInterval(() => {
    if (!room.roundEndsAt) return;
    const remaining = room.roundEndsAt - Date.now();
    if (remaining <= 0) {
      endRound(room, 'Time up');
      return;
    }
    broadcastRoom(room);
  }, 1000);
  io.to(room.id).emit('system:message', {
    text: `Round ${room.currentRound} started. Active team: ${room.activeTeam.toUpperCase()}.`,
  });
  broadcastRoom(room);
}

/**
 * Start the entire game: resets scores, prepares the first round.
 */
function startGame(room) {
  room.inProgress = true;
  room.currentRound = 1;
  room.activeTeam = 'red';
  room.teams.red.score = 0;
  room.teams.blue.score = 0;
  room.board = makeBoard(14);
  room.correctThisRound = 0;
  room.roundEndsAt = null;
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  io.to(room.id).emit('system:message', { text: 'Game started!' });
  broadcastRoom(room);
  startRound(room);
}

/**
 * End the current round. If the game has more rounds, prepare the next one.
 */
function endRound(room, reason = 'Time up') {
  if (!room.inProgress || !room.roundEndsAt) return;
  clearInterval(room.timer);
  room.timer = null;
  room.roundEndsAt = null;
  io.to(room.id).emit('system:message', {
    text: `Round ${room.currentRound} ended (${reason}).`,
  });
  room.currentRound += 1;
  // Alternate the active team each round
  room.activeTeam = room.activeTeam === 'red' ? 'blue' : 'red';
  // Clear operator assignments
  room.teams.red.operatorId = null;
  room.teams.blue.operatorId = null;
  for (const pid of Object.keys(room.players)) {
    room.players[pid].isOperator = false;
  }
  room.correctThisRound = 0;
  if (room.currentRound > room.roundsTotal) {
    room.inProgress = false;
    const r = room.teams.red.score;
    const b = room.teams.blue.score;
    let winner = 'Tie game!';
    if (r > b) winner = 'Red team wins!';
    else if (b > r) winner = 'Blue team wins!';
    io.to(room.id).emit('system:message', {
      text: `Game Over. ${winner}`,
    });
    broadcastRoom(room);
  } else {
    // Prepare a new board for the next round
    room.board = makeBoard(14);
    broadcastRoom(room);
    io.to(room.id).emit('system:message', {
      text: `Get ready for Round ${room.currentRound} — claim operators!`,
    });
  }
}

// Handle socket connections
io.on('connection', (socket) => {
  /**
   * Create a new room. The creator becomes the host and first player.
   */
  socket.on('room:create', ({ gameName, rounds, hostName }, cb) => {
    // Generate a simple 5-digit room code; ensure uniqueness by retrying if necessary
    let id;
    do {
      id = String(Math.floor(10000 + Math.random() * 90000));
    } while (rooms.has(id));
    const room = {
      id,
      name: gameName?.trim() || 'Untitled Game',
      hostId: socket.id,
      roundsTotal: Math.max(1, Math.min(12, Number(rounds) || 6)),
      currentRound: 0,
      inProgress: false,
      activeTeam: 'red',
      roundEndsAt: null,
      timer: null,
      board: makeBoard(14),
      correctThisRound: 0,
      teams: {
        red: { score: 0, operatorId: null },
        blue: { score: 0, operatorId: null },
      },
      players: {},
      ttlTimer: null,
    };
    rooms.set(id, room);
    socket.join(id);
    room.players[socket.id] = {
      name: hostName?.trim() || 'Host',
      team: null,
      isOperator: false,
    };
    cb?.({ ok: true, roomId: id });
    broadcastRoom(room);
    io.to(id).emit('system:message', {
      text: `Room ${id} created by ${room.players[socket.id].name}.`,
    });
  });

  /**
   * Join an existing room. If the room is empty and queued for deletion, cancel the deletion.
   */
  socket.on('room:join', ({ roomId, playerName }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    socket.join(room.id);
    // Register or update player entry
    let p = room.players[socket.id];
    if (!p) {
      p = room.players[socket.id] = {
        name: (playerName || 'Player').trim(),
        team: null,
        isOperator: false,
      };
    } else {
      p.name = (playerName || p.name || 'Player').trim();
    }
    // Assign host if missing
    if (!room.hostId || !room.players[room.hostId]) {
      room.hostId = socket.id;
    }
    // Cancel scheduled deletion if necessary
    if (room.ttlTimer) {
      clearTimeout(room.ttlTimer);
      room.ttlTimer = null;
    }
    cb?.({ ok: true, state: roomStateForClient(room, socket.id) });
    io.to(room.id).emit('system:message', { text: `${p.name} joined.` });
    broadcastRoom(room);
  });

  /**
   * Choose or switch teams. Ensures only one operator per team.
   */
  socket.on('room:chooseTeam', ({ roomId, team }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    if (!['red', 'blue'].includes(team)) {
      cb?.({ ok: false, error: 'Invalid team' });
      return;
    }
    let p = room.players[socket.id];
    if (!p) {
      // If the player record is missing (e.g. due to reconnect race), create it
      p = room.players[socket.id] = { name: 'Player', team: null, isOperator: false };
    }
    // If switching off an operator role, release operator
    if (p.team && room.teams[p.team].operatorId === socket.id) {
      room.teams[p.team].operatorId = null;
      p.isOperator = false;
    }
    p.team = team;
    cb?.({ ok: true });
    io.to(room.id).emit('system:message', { text: `${p.name} joined ${team.toUpperCase()} team.` });
    broadcastRoom(room);
  });

  /**
   * Claim or release the operator role for the player's team.
   */
  socket.on('room:claimOperator', ({ roomId }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const p = room.players[socket.id];
    if (!p || !p.team) {
      cb?.({ ok: false, error: 'Join a team first.' });
      return;
    }
    const team = p.team;
    // If there is already an operator for the team and it's not this socket, deny
    if (room.teams[team].operatorId && room.teams[team].operatorId !== socket.id) {
      cb?.({ ok: false, error: 'Your team already has an operator this round.' });
      return;
    }
    const newState = !p.isOperator;
    p.isOperator = newState;
    room.teams[team].operatorId = newState ? socket.id : null;
    cb?.({ ok: true, isOperator: newState });
    if (newState) {
      io.to(room.id).emit('system:message', { text: `${p.name} claimed operator for ${team.toUpperCase()} team.` });
    } else {
      io.to(room.id).emit('system:message', { text: `${p.name} released operator.` });
    }
    broadcastRoom(room);
  });

  /**
   * Start the game (host only).
   */
  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    if (socket.id !== room.hostId) {
      cb?.({ ok: false, error: 'Only host can start the game.' });
      return;
    }
    if (room.inProgress) {
      cb?.({ ok: false, error: 'Game already started.' });
      return;
    }
    startGame(room);
    cb?.({ ok: true });
  });

  /**
   * Start a round manually (host only).
   */
  socket.on('game:startRound', ({ roomId }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    if (socket.id !== room.hostId) {
      cb?.({ ok: false, error: 'Only host can start a round.' });
      return;
    }
    if (!room.inProgress || room.roundEndsAt) {
      cb?.({ ok: false, error: 'Cannot start round now.' });
      return;
    }
    startRound(room);
    cb?.({ ok: true });
  });

  /**
   * Advance to the next round immediately (host only).
   */
  socket.on('game:nextRound', ({ roomId }, cb) => {
    const room = rooms.get(String(roomId));
    if (!room) {
      cb?.({ ok: false, error: 'Room not found.' });
      return;
    }
    if (socket.id !== room.hostId) {
      cb?.({ ok: false, error: 'Only host can advance.' });
      return;
    }
    if (!room.inProgress) {
      cb?.({ ok: false, error: 'Game not started.' });
      return;
    }
    endRound(room, 'Advanced by host');
    if (room.inProgress) startRound(room);
    cb?.({ ok: true });
  });

  /**
   * Handle a clue message from the active team's operator.
   */
  socket.on('chat:clue', ({ roomId, text }) => {
    const room = rooms.get(String(roomId));
    if (!room || !room.inProgress || !room.roundEndsAt) return;
    const p = room.players[socket.id];
    if (!p || !p.team) return;
    const team = p.team;
    // Only the active team's operator can send clues
    if (team !== room.activeTeam) return;
    if (room.teams[team].operatorId !== socket.id) return;
    const clean = String(text || '').trim().slice(0, 140);
    if (!clean) return;
    io.to(room.id).emit('chat:message', {
      type: 'clue',
      from: p.name,
      team,
      content: clean,
      ts: Date.now(),
    });
  });

  /**
   * Handle a guess from an active team player (non-operator).
   */
  socket.on('chat:guess', ({ roomId, text }) => {
    const room = rooms.get(String(roomId));
    if (!room || !room.inProgress || !room.roundEndsAt) return;
    if (Date.now() > room.roundEndsAt) return;
    const p = room.players[socket.id];
    if (!p || !p.team) return;
    const team = p.team;
    // Only active team may guess
    if (team !== room.activeTeam) return;
    // Operator may not guess
    if (room.teams[team].operatorId === socket.id) return;
    const guess = String(text || '').trim().toLowerCase().slice(0, 40);
    if (!guess) return;
    io.to(room.id).emit('chat:message', {
      type: 'guess',
      from: p.name,
      team,
      content: guess,
      ts: Date.now(),
    });
    // Check if the guess matches any unguessed word
    const idx = room.board.findIndex(
      (w) => !w.guessed && w.text.toLowerCase() === guess
    );
    if (idx >= 0) {
      const tile = room.board[idx];
      tile.guessed = true;
      const pts = tile.points;
      room.teams[team].score += pts;
      // Do not emit a system message when a player finds a word.
      // The contribution view will highlight correct guesses instead.
      // Increase correct count for this round and add a new word if threshold reached
      room.correctThisRound += 1;
      if (
        room.correctThisRound >= EXPAND_AFTER &&
        room.board.length < MAX_BOARD_SIZE
      ) {
        const set = new Set(room.board.map((b) => b.text));
        const next = pickWord(set);
        room.board.push({ ...next, guessed: false });
      }
      broadcastRoom(room);
    }
  });

  /**
   * Clean up when a client disconnects. Reassign host and start TTL if room becomes empty.
   */
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (!room.players[socket.id]) continue;
      const player = room.players[socket.id];
      const wasHost = room.hostId === socket.id;
      const team = player.team;
      // Release operator if leaving
      if (team && room.teams[team].operatorId === socket.id) {
        room.teams[team].operatorId = null;
      }
      delete room.players[socket.id];
      io.to(room.id).emit('system:message', { text: `${player.name} disconnected.` });
      // Reassign host if necessary
      if (wasHost) {
        const remainingIds = Object.keys(room.players);
        room.hostId = remainingIds[0] || null;
        if (room.hostId) {
          io.to(room.id).emit('system:message', { text: 'Host left. New host assigned.' });
        }
      }
      // If no players left, schedule deletion
      if (Object.keys(room.players).length === 0) {
        if (room.timer) {
          clearInterval(room.timer);
          room.timer = null;
          room.roundEndsAt = null;
        }
        if (!room.ttlTimer) {
          room.ttlTimer = setTimeout(() => {
            rooms.delete(room.id);
          }, ROOM_TTL_MS);
        }
      } else {
        broadcastRoom(room);
      }
      break;
    }
  });
});

// Start the HTTP server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});