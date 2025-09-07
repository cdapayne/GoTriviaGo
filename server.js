const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
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
      current: null
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

  socket.on('adminStartQuestion', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.remaining.length === 0) {
      console.error(`adminStartQuestion: room ${roomCode} not found or no questions remaining`);
      return;
    }
    const idx = Math.floor(Math.random() * room.remaining.length);
    const sel = room.remaining.splice(idx, 1)[0];
    room.current = sel;
    room.questionStart = Date.now();
    const q = room.categories[sel.ci].questions[sel.qi];
    Object.values(room.players).forEach(p => {
      p.answered = false;
      p.answer = null;
      p.correct = null;
    });
    io.to(roomCode).emit('question', {
      category: room.categories[sel.ci].name,
      text: q.text,
      options: q.options
    });
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
    io.to(roomCode).emit('players', Object.values(room.players).map(p => p.name));
    io.to(roomCode).emit('scores', Object.values(room.players).map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('viewerJoin', ({ roomCode }) => {
    if (rooms[roomCode]) {
      socket.join(roomCode);
      const room = rooms[roomCode];
      socket.emit('scores', Object.values(room.players).map(p => ({ name: p.name, score: p.score })));
    } else {
      console.error(`viewerJoin: room ${roomCode} not found`);
    }
  });

  socket.on('playerBuzz', ({ roomCode }) => {
    socket.emit('buzzAccepted');
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
    const q = room.categories[room.current.ci].questions[room.current.qi];
    const correct = answer === q.answer;
    player.answered = true;
    player.answer = answer;
    player.correct = correct;
    if (correct) player.score += 1;
    const time = room.questionStart ? Date.now() - room.questionStart : 0;
    io.to(roomCode).emit('playerAnswered', { name: player.name, answer, correct, time });
    io.to(roomCode).emit('scores', Object.values(room.players).map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit('players', Object.values(room.players).map(p => p.name));
        io.to(code).emit('scores', Object.values(room.players).map(p => ({ name: p.name, score: p.score })));
      }
      if (room.admin === socket.id) {
        io.to(code).emit('roomClosed');
        delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
