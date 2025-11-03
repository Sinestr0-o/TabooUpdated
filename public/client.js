const socket = io();
const $ = (sel) => document.querySelector(sel);

// Extract room ID from URL parameters
const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
// Retrieve saved player name from sessionStorage
const savedName = sessionStorage.getItem('playerName') || '';

// Local state tracking the current player and room
const state = {
  me: { id: null, name: savedName, team: null, isOperator: false },
  room: null,
};

let joined = false;
let lastRound = 0;
// Map to track contributions per player (name -> DOM row)
const contributions = new Map();

// Cache some frequently accessed DOM elements
const boardEl = $('#board');
const chatStream = $('#chatStream');
const chatInput = $('#chatInput');
const sendBtn = $('#sendBtn');

// Bind UI button actions
document.getElementById('teamRed').onclick = () => chooseTeam('red');
document.getElementById('teamBlue').onclick = () => chooseTeam('blue');
document.getElementById('claimOperatorBtn').onclick = () => {
  socket.emit('room:claimOperator', { roomId }, (res) => {
    if (!res || !res.ok) {
      hint(res && res.error ? res.error : 'Cannot claim operator');
    }
  });
};

document.getElementById('startGameBtn').onclick = () => {
  socket.emit('game:start', { roomId }, (res) => {
    if (!res || !res.ok) {
      hint(res && res.error ? res.error : 'Cannot start game');
    }
  });
};
document.getElementById('startRoundBtn').onclick = () => {
  socket.emit('game:startRound', { roomId }, (res) => {
    if (!res || !res.ok) {
      hint(res && res.error ? res.error : 'Cannot start round');
    }
  });
};
document.getElementById('nextRoundBtn').onclick = () => {
  socket.emit('game:nextRound', { roomId }, (res) => {
    if (!res || !res.ok) {
      hint(res && res.error ? res.error : 'Cannot go next');
    }
  });
};

sendBtn.onclick = sendMessage;
chatInput.onkeydown = (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
};

/**
 * Attempt to join the room. If the join fails, redirect back to lobby.
 */
function joinRoom() {
  socket.emit('room:join', { roomId, playerName: savedName || 'Player' }, (res) => {
    if (!res || !res.ok) {
      alert(res && res.error ? res.error : 'Failed to join room');
      window.location.href = '/';
      return;
    }
    joined = true;
    state.room = res.state;
    state.me.id = socket.id;
    render(state.room);
    document.getElementById('gameTitle').textContent = state.room.name;
    document.getElementById('roomIdBadge').textContent = `Room #${state.room.id}`;
    lastRound = state.room.currentRound;
  });
}

// Join immediately
joinRoom();
// If socket reconnects and join wasn't acknowledged yet, retry
socket.on('connect', () => {
  if (!joined) {
    joinRoom();
  }
});

/**
 * Render the current room state into the DOM.
 */
function render(r) {
  document.getElementById('roundsLabel').textContent = r.roundsTotal;
  document.getElementById('roundNow').textContent = r.currentRound;
  document.getElementById('activeTeam').textContent = r.activeTeam
    ? r.activeTeam.toUpperCase()
    : '—';
  document.getElementById('timer').textContent = formatMs(r.timeRemaining);

  const hostPlayer = r.players.find((p) => p.id === r.hostId);
  document.getElementById('hostName').textContent = hostPlayer ? hostPlayer.name : '—';
  document.getElementById('scoreRed').textContent = r.teams.red.score;
  document.getElementById('scoreBlue').textContent = r.teams.blue.score;

  // Update players list
  document.getElementById('listRed').innerHTML = '';
  document.getElementById('listBlue').innerHTML = '';
  r.players.forEach((p) => {
    if (p.id === socket.id) {
      state.me.team = p.team;
      state.me.isOperator = p.isOperator;
    }
    const li = document.createElement('li');
    li.textContent = p.name + (p.isOperator ? ' (Operator)' : '');
    if (p.team === 'red') {
      document.getElementById('listRed').appendChild(li);
    } else if (p.team === 'blue') {
      document.getElementById('listBlue').appendChild(li);
    }
  });

  // Button states
  const isHost = r.hostId === socket.id;
  document.getElementById('startGameBtn').disabled = !isHost || r.inProgress;
  document.getElementById('startRoundBtn').disabled = !isHost || !r.inProgress || !!r.timeRemaining;
  document.getElementById('nextRoundBtn').disabled = !isHost || !r.inProgress || !!r.timeRemaining;

  // Chat input availability and placeholder
  const myTeam = state.me.team;
  const isOp = state.me.isOperator;
  const canClue = r.inProgress && r.activeTeam === myTeam && isOp;
  const canGuess = r.inProgress && r.activeTeam === myTeam && !isOp;
  chatInput.placeholder = canClue
    ? 'Type a clue for your team…'
    : canGuess
    ? 'Type your guess (exact word)…'
    : 'Waiting…';
  chatInput.disabled = !(canClue || canGuess);
  sendBtn.disabled = chatInput.disabled;

  // Render word board
  boardEl.innerHTML = '';
  if (!r.boardVisible) {
    const div = document.createElement('div');
    div.className = 'board-hidden';
    div.textContent = "It's your team's turn to guess; board is hidden.";
    boardEl.appendChild(div);
  } else {
    for (const tile of r.board) {
      const el = document.createElement('div');
      el.className = 'tile' + (tile.guessed ? ' guessed' : '');
      el.innerHTML = `<div class="tile-inner"><div class="word">${escapeHtml(
        tile.text
      )}</div><div class="points">${tile.points} points</div></div>`;
      boardEl.appendChild(el);
    }
  }
  document.getElementById('footNotice').textContent = r.inProgress
    ? `Round ${r.currentRound}/${r.roundsTotal} — ${r.activeTeam.toUpperCase()} turn`
    : 'Waiting to start…';
}

/**
 * Choose a team (red or blue).
 */
function chooseTeam(team) {
  socket.emit('room:chooseTeam', { roomId, team }, (res) => {
    if (!res || !res.ok) {
      hint(res && res.error ? res.error : 'Failed to join team');
    }
  });
}

/**
 * Display a temporary hint message to the user.
 */
function hint(text) {
  document.getElementById('chatHint').textContent = text;
  setTimeout(() => {
    document.getElementById('chatHint').textContent = '';
  }, 2500);
}

/**
 * Escape HTML special characters in a string to prevent XSS.
 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c];
  });
}

/**
 * Format milliseconds into a MM:SS string.
 */
function formatMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Reset the contributions display. Called on round changes.
 */
function resetContributions() {
  contributions.clear();
  chatStream.innerHTML = '';
}

/**
 * Send a clue or guess depending on the current player's role.
 */
function sendMessage() {
  const txt = chatInput.value.trim();
  if (!txt) return;
  const r = state.room;
  const my = state.me;
  const canClue = r && r.inProgress && r.activeTeam === my.team && my.isOperator;
  const canGuess = r && r.inProgress && r.activeTeam === my.team && !my.isOperator;
  if (canClue) {
    socket.emit('chat:clue', { roomId, text: txt });
  } else if (canGuess) {
    socket.emit('chat:guess', { roomId, text: txt });
  } else {
    hint('You cannot send messages right now.');
  }
  chatInput.value = '';
}

// Handle incoming room updates
socket.on('room:update', (room) => {
  state.room = room;
  render(room);
  // If the round changed, reset contributions
  if (lastRound !== room.currentRound) {
    lastRound = room.currentRound;
    resetContributions();
  }
  // Highlight correctly guessed words in contributions
  const guessedWordsLower = room.board
    .filter((w) => w.guessed)
    .map((w) => w.text.toLowerCase());
  chatStream.querySelectorAll('.guess-tag').forEach((tag) => {
    if (guessedWordsLower.includes(tag.textContent.trim().toLowerCase())) {
      if (!tag.classList.contains('correct')) {
        tag.classList.add('correct');
        const team = tag.dataset.team;
        if (team) tag.classList.add(team);
      }
    }
  });
});

// Handle chat messages (guesses and clues)
socket.on('chat:message', (msg) => {
  if (msg.type === 'guess') {
    const playerName = msg.from;
    let row = contributions.get(playerName);
    if (!row) {
      row = document.createElement('div');
      row.className = 'contribution';
      const playerDiv = document.createElement('div');
      playerDiv.className = 'player';
      playerDiv.textContent = playerName;
      const guessesDiv = document.createElement('div');
      guessesDiv.className = 'guesses';
      row.appendChild(playerDiv);
      row.appendChild(guessesDiv);
      contributions.set(playerName, row);
      chatStream.appendChild(row);
    }
    const tag = document.createElement('div');
    tag.className = 'guess-tag';
    tag.textContent = msg.content.toUpperCase();
    tag.dataset.team = msg.team;
    row.querySelector('.guesses').appendChild(tag);
  } else if (msg.type === 'clue') {
    // Display clues as a standalone message line
    const row = document.createElement('div');
    row.className = 'msg clue';
    row.innerHTML = `<span class="from ${msg.team}">${escapeHtml(msg.from)}</span>: ${escapeHtml(msg.content)}`;
    chatStream.appendChild(row);
  }
  chatStream.scrollTop = chatStream.scrollHeight;
});

// Handle system messages
socket.on('system:message', (m) => {
  const row = document.createElement('div');
  row.className = 'msg system';
  row.textContent = m.text;
  chatStream.appendChild(row);
  chatStream.scrollTop = chatStream.scrollHeight;
});