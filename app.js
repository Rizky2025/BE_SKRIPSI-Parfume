const express = require('express');
const cors = require('cors');
const router = require('./routers');

const app = express();

app.use(cors());
app.use(express.json()); // Body parser untuk JSON
app.use(express.urlencoded({ extended: true }));

// Panggil router utama
app.use('/api', router);

// Error handling dasar
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Terjadi kesalahan pada server!' });
});

module.exports = app;