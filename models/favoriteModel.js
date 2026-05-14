const supabase = require('../config/supabase');

const saveFavorite = async (userId, name, brand, notes) => {
    // FIX: Gunakan .maybeSingle() agar tidak melempar error jika parfum belum ada di database
    const { data: existing, error: checkError } = await supabase
        .from('favorites')
        .select('id')
        .eq('user_id', userId)
        .eq('perfume_name', name)
        .maybeSingle(); 

    if (checkError) {
        console.error("[Supabase] Error saat mengecek duplikat:", checkError);
        throw checkError;
    }

    if (existing) {
        const err = new Error('Parfum ini sudah ada di daftar simpan Anda.');
        err.code = 'DUPLICATE';
        throw err;
    }

    const { data, error } = await supabase
        .from('favorites')
        .insert([{ user_id: userId, perfume_name: name, perfume_brand: brand, notes }])
        .select();

    if (error) {
        console.error("[Supabase] Error saat insert data:", error);
        throw error;
    }
    return data;
};

const getFavoritesByUser = async (userId) => {
    const { data, error } = await supabase
        .from('favorites')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error("[Supabase] Error saat mengambil data:", error);
        throw error;
    }
    return data;
};

const deleteFavorite = async (favId, userId) => {
    const { data, error } = await supabase
        .from('favorites')
        .delete()
        .eq('id', favId)
        .eq('user_id', userId)
        .select();

    if (error) {
        console.error("[Supabase] Error saat menghapus data:", error);
        throw error;
    }
    
    if (!data || data.length === 0) {
        const err = new Error('Data tidak ditemukan atau bukan milik Anda.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    return data;
};

module.exports = { saveFavorite, getFavoritesByUser, deleteFavorite };