const supabase = require('../config/supabase');

const saveFavorite = async (userId, name, brand, notes) => {
    // Cek duplikat dulu — jangan simpan parfum yang sama dua kali
    const { data: existing } = await supabase
        .from('favorites')
        .select('id')
        .eq('user_id', userId)
        .eq('perfume_name', name)
        .single();

    if (existing) {
        const err = new Error('Parfum ini sudah ada di favorit Anda.');
        err.code = 'DUPLICATE';
        throw err;
    }

    const { data, error } = await supabase
        .from('favorites')
        .insert([{ user_id: userId, perfume_name: name, perfume_brand: brand, notes }])
        .select();

    if (error) throw error;
    return data;
};

const getFavoritesByUser = async (userId) => {
    const { data, error } = await supabase
        .from('favorites')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }); // terbaru dulu

    if (error) throw error;
    return data;
};

// Hapus favorit berdasarkan id (UUID dari tabel favorites)
const deleteFavorite = async (favId, userId) => {
    // Pastikan yang menghapus adalah pemiliknya
    const { data, error } = await supabase
        .from('favorites')
        .delete()
        .eq('id', favId)
        .eq('user_id', userId)
        .select();

    if (error) throw error;
    if (!data || data.length === 0) {
        const err = new Error('Data tidak ditemukan atau bukan milik Anda.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    return data;
};

module.exports = { saveFavorite, getFavoritesByUser, deleteFavorite };