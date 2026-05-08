// controllers/authController.js
const supabase = require('../config/supabase'); // Pastikan path ini sesuai dengan lokasi supabase.js Anda

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Validasi input dasar
        if (!email || !password) {
            return res.status(400).json({ error: 'Email dan password wajib diisi!' });
        }

        // Login menggunakan Supabase Auth
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });

        // Jika terjadi error dari Supabase (contoh: password salah / email tidak ada)
        if (error) {
            return res.status(401).json({ error: error.message });
        }

        // Jika berhasil, kembalikan data session/token
        res.status(200).json({
            message: 'Login berhasil!',
            user: data.user,
            session: data.session
        });

    } catch (err) {
        next(err); // Lempar ke error handler di app.js
    }
};
const register = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Validasi input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email dan password wajib diisi!' });
        }

        // Proses registrasi menggunakan Supabase Auth
        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: password,
        });

        // Jika error dari Supabase (misal: email sudah terdaftar atau password terlalu lemah)
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        // Berhasil register
        res.status(201).json({
            message: 'Registrasi berhasil! Silakan cek email Anda untuk verifikasi (jika fitur verifikasi aktif).',
            user: data.user
        });

    } catch (err) {
        next(err);
    }
};
module.exports = {
    login,
    register
};