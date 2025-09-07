const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function getScores(room) {
  const scores = Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, score: p.score }));
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function emitPlayers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const list = Object.entries(room.players).map(([id, p]) => ({ id, name: p.name }));
  io.to(room.admin).emit('players', list);
}

function emitScores(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const scores = getScores(room);
  io.to(room.admin).emit('scores', scores);
  io.to(roomCode).emit('scores', scores);
}

function handleTimeUp(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.current) return;
  Object.values(room.players).forEach(p => {
    if (!p.answered) {
      p.answered = true;
      p.answer = null;
      p.correct = false;
      p.time = room.timeLimit;
    }
  });
  room.questionTimer = null;
  io.to(roomCode).emit('timeUp');
  if (room.questionCount % 5 === 0) {
    startMiniGame(roomCode);
  } else if (room.remaining.length > 0 && room.lastSettings) {
    setTimeout(() => startQuestion(roomCode, room.lastSettings.randomize, room.lastSettings.timeLimit), 3000);
  }
}

function startMiniGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const duration = 10000; // 10 seconds
  room.miniGame = {
    start: Date.now(),
    duration,
    counts: {}
  };
  io.to(roomCode).emit('miniGameStart', {
    startTime: room.miniGame.start,
    duration
  });
  room.miniGameTimer = setTimeout(() => endMiniGame(roomCode), duration);
}

function endMiniGame(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.miniGame) return;
  const counts = room.miniGame.counts;
  let winnerId = null;
  let max = -1;
  for (const [id, count] of Object.entries(counts)) {
    if (count > max) {
      max = count;
      winnerId = id;
    }
  }
  let winner = null;
  if (winnerId && room.players[winnerId]) {
    room.players[winnerId].score += 1;
    winner = { id: winnerId, name: room.players[winnerId].name, count: max };
  }
  emitScores(roomCode);
  io.to(roomCode).emit('miniGameEnd', { winner });
  clearTimeout(room.miniGameTimer);
  room.miniGame = null;
  room.miniGameTimer = null;
  if (room.remaining.length > 0 && room.lastSettings) {
    setTimeout(() => startQuestion(roomCode, room.lastSettings.randomize, room.lastSettings.timeLimit), 3000);
  }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function startQuestion(roomCode, randomize, timeLimit) {
  const room = rooms[roomCode];
  if (!room || room.remaining.length === 0) {
    console.error(`startQuestion: room ${roomCode} not found or no questions remaining`);
    return;
  }
  room.lastSettings = { randomize, timeLimit };
  const idx = Math.floor(Math.random() * room.remaining.length);
  const sel = room.remaining.splice(idx, 1)[0];
  const q = room.categories[sel.ci].questions[sel.qi];

  let options = [...q.options];
  let answer = q.answer;
  if (randomize) {
    const arr = options.map((o, i) => ({ o, i }));
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    options = arr.map(a => a.o);
    answer = arr.findIndex(a => a.i === q.answer);
  }

  room.current = { ci: sel.ci, qi: sel.qi, options, answer };
  room.questionStart = Date.now();
  room.timeLimit = timeLimit ? timeLimit * 1000 : null;
  if (room.questionTimer) clearTimeout(room.questionTimer);
  if (room.timeLimit) {
    room.questionTimer = setTimeout(() => handleTimeUp(roomCode), room.timeLimit);
  } else {
    room.questionTimer = null;
  }
  room.questionCount = (room.questionCount || 0) + 1;

  Object.values(room.players).forEach(p => {
    p.answered = false;
    p.answer = null;
    p.correct = null;
    p.time = null;
  });

  io.to(roomCode).emit('question', {
    category: room.categories[sel.ci].name,
    text: q.text,
    options,
    timeLimit: room.timeLimit,
    startTime: room.questionStart
  });
}

io.on('connection', socket => {
  socket.on('adminCreateRoom', () => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms[code]);
    rooms[code] = {
      admin: socket.id,
      players: {},
      categories: [],
      remaining: [],
      current: null,
      questionCount: 0,
      miniGame: null,
      miniGameTimer: null
    };
    socket.join(code);
    socket.emit('roomCreated', code);
  });

  socket.on('adminSetup', ({ roomCode, categories }) => {
    const room = rooms[roomCode];
    if (!room) {
      console.error(`adminSetup: room ${roomCode} not found`);
      return;
    }
    room.categories = categories;
    room.remaining = [];
    categories.forEach((cat, ci) => {
      cat.questions.forEach((q, qi) => {
        room.remaining.push({ ci, qi });
      });
    });
    io.to(roomCode).emit('setupComplete');
  });

  socket.on('adminGenerate', async ({ roomCode, prompt, apiKey }) => {
    const room = rooms[roomCode];
    if (!room) {
      console.error(`adminGenerate: room ${roomCode} not found`);
      return;
    }
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a trivia question generator. Produce JSON with 4 categories, each with 5 questions. Format: [{"name":"<category>","questions":[{"text":"<question>","options":["A","B","C","D"],"answer":0}]}]' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7
        })
      });
      const data = await response.json();
      let text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('No content returned');
      text = text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n/, '').replace(/```$/, '').trim();
      }
      let categories;
      try {
        categories = JSON.parse(text);
      } catch (parseErr) {
        console.error('adminGenerate parse error:', parseErr, text);
        io.to(socket.id).emit('generationError', 'Invalid AI response format');
        return;
      }
      room.categories = categories;
      room.remaining = [];
      categories.forEach((cat, ci) => {
        cat.questions.forEach((q, qi) => {
          room.remaining.push({ ci, qi });
        });
      });
      io.to(socket.id).emit('generatedQuestions', categories);
    } catch (err) {
      console.error('adminGenerate error:', err);
      io.to(socket.id).emit('generationError', err.message);
    }
  });

  socket.on('adminStartQuestion', ({ roomCode, randomize, timeLimit }) => {
    startQuestion(roomCode, randomize, timeLimit);
  });

  socket.on('playerJoin', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) {
      console.error(`playerJoin: room ${roomCode} not found`);
      return;
    }
    room.players[socket.id] = { name, score: 0, answered: false };
    socket.join(roomCode);
    socket.emit('joined', roomCode);
    emitPlayers(roomCode);
    emitScores(roomCode);

    // If a question is already active, send it to the newly joined player
    if (room.current) {
      const q = room.categories[room.current.ci].questions[room.current.qi];
      socket.emit('question', {
        category: room.categories[room.current.ci].name,
        text: q.text,
        options: room.current.options,
        timeLimit: room.timeLimit,
        startTime: room.questionStart
      });
    }
  });

  socket.on('viewerJoin', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room) {
      socket.join(roomCode);

      // Sync the viewer with the current question if one is active
      if (room.current) {
        const q = room.categories[room.current.ci].questions[room.current.qi];
        socket.emit('question', {
          category: room.categories[room.current.ci].name,
          text: q.text,
          options: room.current.options,
          timeLimit: room.timeLimit,
          startTime: room.questionStart
        });
      }
      emitScores(roomCode);
    } else {
      console.error(`viewerJoin: room ${roomCode} not found`);
    }
  });

  socket.on('playerBuzz', ({ roomCode }) => {
    socket.emit('buzzAccepted');
  });

  socket.on('adminRemovePlayer', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players[playerId]) {
      const target = io.sockets.sockets.get(playerId);
      if (target) {
        target.leave(roomCode);
        target.emit('removed');
      }
      delete room.players[playerId];
      emitPlayers(roomCode);
      emitScores(roomCode);
    }
  });

  socket.on('playerAnswer', ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || !room.current) {
      console.error(`playerAnswer: room ${roomCode} not found or no active question`);
      return;
    }
    const player = room.players[socket.id];
    if (!player) {
      console.error(`playerAnswer: player ${socket.id} not found in room ${roomCode}`);
      return;
    }
    if (player.answered) {
      console.warn(`playerAnswer: player ${socket.id} already answered`);
      return;
    }
    if (room.timeLimit && Date.now() - room.questionStart > room.timeLimit) {
      console.warn('playerAnswer: answer after time up');
      return;
    }
    const correct = answer === room.current.answer;
    player.answered = true;
    player.answer = answer;
    player.correct = correct;
    player.time = Date.now() - room.questionStart;
    if (correct) player.score += 1;
    io.to(roomCode).emit('playerAnswered', { name: player.name, answer, correct, time: player.time });
    emitScores(roomCode);
    const allAnswered = Object.values(room.players).every(p => p.answered);
    if (allAnswered) {
      if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
      if (room.questionCount % 5 === 0) {
        startMiniGame(roomCode);
      } else if (room.remaining.length > 0 && room.lastSettings) {
        setTimeout(() => startQuestion(roomCode, room.lastSettings.randomize, room.lastSettings.timeLimit), 3000);
      }
    }
  });

  socket.on('miniGameTap', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.miniGame) return;
    room.miniGame.counts[socket.id] = (room.miniGame.counts[socket.id] || 0) + 1;
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.miniGame && room.miniGame.counts) {
          delete room.miniGame.counts[socket.id];
        }
        emitPlayers(code);
        emitScores(code);
      }
      if (room.admin === socket.id) {
        io.to(code).emit('roomClosed');
        if (room.miniGameTimer) clearTimeout(room.miniGameTimer);
        delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
