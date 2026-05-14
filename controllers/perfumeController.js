const FavoriteModel = require('../models/favoriteModel');
const axios = require('axios');
const supabase = require('../config/supabase');

// =============================================================
// DB CACHE: Simpan semua data perfume sekali saja saat startup
// Agar tidak query DB berulang-ulang setiap request
// =============================================================
let allPerfumesCache = null;
let cacheLoadedAt = null;
const DB_CACHE_TTL_MS = 10 * 60 * 1000; // refresh setiap 10 menit

async function getAllPerfumes() {
    const now = Date.now();
    if (allPerfumesCache && cacheLoadedAt && (now - cacheLoadedAt) < DB_CACHE_TTL_MS) {
        return allPerfumesCache;
    }

    // Ambil semua data dari Supabase (pakai pagination jika data besar)
    let allData = [];
    let from = 0;
    const PAGE_SIZE = 1000;

    while (true) {
        const { data, error } = await supabase
            .from('perfumes')
            .select('*')
            .range(from, from + PAGE_SIZE - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    allPerfumesCache = allData;
    cacheLoadedAt = now;
    console.log(`[DB CACHE] Loaded ${allData.length} perfumes from Supabase`);
    return allData;
}

// =============================================================
// HELPER: Hitung similarity antara dua string (0–1)
// Pakai algoritma token overlap — cocok untuk nama parfum
// Contoh: "1270 Eau de Parfum" vs "1270 eau de parfum" → 1.0
//         "Monyette Paris"     vs "Monyette Paris Fragrance Oil" → 0.67
// =============================================================
function nameSimilarity(mlName, dbName) {
    const a = mlName.toLowerCase().trim();
    const b = dbName.toLowerCase().trim();

    // Exact match
    if (a === b) return 1.0;

    // Salah satu mengandung yang lain
    if (a.includes(b) || b.includes(a)) return 0.9;

    // Token overlap
    const tokensA = new Set(a.split(/\s+/).filter(t => t.length > 1));
    const tokensB = new Set(b.split(/\s+/).filter(t => t.length > 1));
    const intersection = [...tokensA].filter(t => tokensB.has(t));
    const union = new Set([...tokensA, ...tokensB]);

    if (union.size === 0) return 0;
    return intersection.length / union.size; // Jaccard similarity
}

// =============================================================
// HELPER: Cocokkan nama-nama dari ML ke data di DB
// Threshold 0.6 = cukup longgar untuk menangkap variasi nama
// =============================================================
function matchMLNamesToDB(mlResults, allPerfumes) {
    const matched = [];
    const THRESHOLD = 0.6;
    
    // Set baru untuk menyimpan ID parfum database yang sudah dimasukkan
    // agar tidak ada parfum yang tampil 2 kali!
    const seenDbIds = new Set(); 

    for (const mlItem of mlResults) {
        let bestMatch = null;
        let bestScore = 0;

        for (const dbP of allPerfumes) {
            const s = nameSimilarity(mlItem.name, dbP.name);
            if (s > bestScore) {
                bestScore = s;
                bestMatch = dbP;
            }
        }

        // Cek apakah parfum ini SUDAH ADA di array matched menggunakan seenDbIds
        if (bestMatch && bestScore >= THRESHOLD && !seenDbIds.has(bestMatch.id)) {
            seenDbIds.add(bestMatch.id); // Tandai parfum ini sudah dipakai
            matched.push({
                perfume: {
                    ...bestMatch,
                    ai_score: Math.round(mlItem.score * 100) 
                }
            });
        }
    }
    return matched;
}

// =============================================================
// IN-MEMORY HISTORY: Lacak parfum yang sudah pernah direkomendasikan
// per user/session agar tidak muncul berulang
// =============================================================
const recommendationHistory = new Map();
const cacheTimestamps = new Map();
const HISTORY_TTL_MS = 60 * 60 * 1000; // 1 jam

setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of cacheTimestamps.entries()) {
        if (now - ts > HISTORY_TTL_MS) {
            recommendationHistory.delete(key);
            cacheTimestamps.delete(key);
        }
    }
}, 30 * 60 * 1000);

// =============================================================
// CONTROLLER UTAMA: getRecommendations (perfumeController.js)
// =============================================================
// Di dalam perfumeController.js
const getRecommendations = async (req, res) => {
    try {
      const { user_input, gender, waktu_pemakaian, kegiatan, wangi } = req.body;
  
      // 1. Panggil API Python FastAPI
      const response = await axios.post('http://127.0.0.1:8000/recommend', {
        user_input, gender, waktu_pemakaian, kegiatan, wangi
      });
  
      const allData = response.data.data;
  
      // 2. PERBAIKAN: Gunakan properti 'tipe' dari Python, bukan mengandalkan string debug_alasan
      const cbfData = allData.filter(item => item.tipe === "CBF" || (item.debug_alasan && item.debug_alasan.includes("Metode CBF")));
      const cfData = allData.filter(item => item.tipe === "CF" || (item.debug_alasan && item.debug_alasan.includes("Metode CF")));
  
      res.status(200).json({
        status: "success",
        cbf: cbfData,
        cf: cfData
      });
  
    } catch (error) {
      console.error("Error AI API:", error.message);
      res.status(500).json({ error: "Gagal mendapatkan rekomendasi AI" });
    }
  };

// =============================================================
// CONTROLLER: Reset history
// =============================================================
const resetRecommendationHistory = async (req, res) => {
    try {
        const sessionKey = req.body.userId || req.body.sessionId || 'guest';
        recommendationHistory.delete(sessionKey);
        cacheTimestamps.delete(sessionKey);
        return res.status(200).json({ message: `History untuk '${sessionKey}' berhasil direset.` });
    } catch (error) {
        return res.status(500).json({ error: "Gagal mereset history." });
    }
};

// =============================================================
// CONTROLLER: saveFavorite
// =============================================================
const saveFavorite = async (req, res) => {
    try {
        const { name, brand, notes } = req.body;

        // FIX 1: Baca userId/sessionId dari request, bukan hardcode
        const userId = req.body.userId || req.body.sessionId;

        if (!userId) {
            return res.status(400).json({ error: "userId atau sessionId wajib dikirim." });
        }

        if (!name) {
            return res.status(400).json({ error: "Nama parfum wajib diisi." });
        }

        // FIX 2: Pakai FavoriteModel agar cek duplikat berjalan
        const result = await FavoriteModel.saveFavorite(userId, name, brand, notes);

        return res.status(201).json({
            message: "Berhasil menambahkan ke favorit!",
            data: result
        });

    } catch (error) {
        // FIX 3: Tangani error duplikat dengan pesan yang jelas
        if (error.code === 'DUPLICATE') {
            return res.status(409).json({ error: error.message });
        }
        console.error("Error saving favorite:", error.message);
        return res.status(500).json({ error: "Gagal menyimpan favorit." });
    }
};

// =============================================================
// CONTROLLER: getUserFavorites
// =============================================================
const getUserFavorites = async (req, res) => {
    try {
        const { userId } = req.params;
        const favorites = await FavoriteModel.getFavoritesByUser(userId);
        res.status(200).json({ data: favorites });
    } catch (error) {
        console.error("Error getting favorites:", error);
        res.status(500).json({ error: "Gagal mengambil data favorit" });
    }
};

const deleteFavorite = async (req, res) => {
    try {
        const { favId } = req.params;
        const userId = req.body.userId || req.query.userId;
 
        if (!favId) {
            return res.status(400).json({ error: "ID favorit wajib diisi." });
        }
 
        // Untuk guest pakai sessionId
        const ownerId = userId || req.body.sessionId || req.query.sessionId || 'guest';
 
        await FavoriteModel.deleteFavorite(favId, ownerId);
        res.status(200).json({ message: "Berhasil dihapus dari favorit." });
 
    } catch (error) {
        if (error.code === 'NOT_FOUND') {
            return res.status(404).json({ error: error.message });
        }
        console.error("Error deleting favorite:", error);
        res.status(500).json({ error: "Gagal menghapus favorit." });
    }
};
 

module.exports = {
    getRecommendations,
    resetRecommendationHistory,
    saveFavorite,
    getUserFavorites,
    deleteFavorite
};