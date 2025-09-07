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
    if (!room) return;
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
    if (!room) return;
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
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const categories = JSON.parse(text);
      room.categories = categories;
      room.remaining = [];
      categories.forEach((cat, ci) => {
        cat.questions.forEach((q, qi) => {
          room.remaining.push({ ci, qi });
        });
      });
      io.to(socket.id).emit('generatedQuestions', categories);
    } catch (err) {
      io.to(socket.id).emit('generationError', err.message);
    }
  });

  socket.on('adminStartQuestion', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.remaining.length === 0) return;
    const idx = Math.floor(Math.random() * room.remaining.length);
    const sel = room.remaining.splice(idx, 1)[0];
    room.current = sel;
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
    if (!room) return;
    room.players[socket.id] = { name, score: 0, answered: false };
    socket.join(roomCode);
    socket.emit('joined', roomCode);
    io.to(roomCode).emit('players', Object.values(room.players).map(p => p.name));
  });

  socket.on('viewerJoin', ({ roomCode }) => {
    if (rooms[roomCode]) socket.join(roomCode);
  });

  socket.on('playerBuzz', ({ roomCode }) => {
    socket.emit('buzzAccepted');
  });

  socket.on('playerAnswer', ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || !room.current) return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;
    const q = room.categories[room.current.ci].questions[room.current.qi];
    const correct = answer === q.answer;
    player.answered = true;
    player.answer = answer;
    player.correct = correct;
    if (correct) player.score += 1;
    io.to(roomCode).emit('playerAnswered', { name: player.name, answer, correct });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit('players', Object.values(room.players).map(p => p.name));
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
