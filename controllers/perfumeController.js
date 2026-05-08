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
const getRecommendations = async (req, res) => {
    try {
        const { input_user, waktu, acara, aroma, gender, isLoadMore } = req.body;
        const sessionKey = req.body.userId || req.body.sessionId || 'guest';

        let userInput = input_user || "";

        if (!userInput) {
            if (waktu === "siang") userInput += "citrus bergamot lemon grapefruit fresh morning light ";
            if (waktu === "malam") userInput += "oud amber musk incense dark smoky evening ";
            if (acara === "santai") userInput += "casual green aquatic clean soft relaxing ";
            if (acara === "formal") userInput += "leather iris vetiver oakmoss sophisticated classic ";
            if (acara === "kencan") userInput += "rose jasmine sandalwood vanilla sensual romantic intimate ";
            if (aroma) userInput += aroma + " ";
            if (gender === "wanita") userInput += "rose floral jasmine feminine soft ";
            if (gender === "pria") userInput += "cedar vetiver tobacco leather woody masculine ";
        }

        if (!userInput.trim()) {
            return res.status(400).json({ error: "Input teks atau kriteria tidak boleh kosong" });
        }

        // Hapus history jika pencarian baru
        if (!isLoadMore) {
            recommendationHistory.set(sessionKey, new Set());
        } else if (!recommendationHistory.has(sessionKey)) {
            recommendationHistory.set(sessionKey, new Set());
        }
        
        cacheTimestamps.set(sessionKey, Date.now());
        const history = recommendationHistory.get(sessionKey);
        
        // Simpan jumlah history sebelum ditambah data baru
        const historySizeBefore = history.size;

        const pythonUrl = process.env.ML_API_URL || 'http://127.0.0.1:5000/recommend';
        const pythonResponse = await axios.post(pythonUrl, {
            input: userInput.trim(),
            top_n: 50 
        });

        const rawRecommendedNames = pythonResponse.data.recommendations || [];

        if (rawRecommendedNames.length === 0) {
            return res.status(200).json({ message: "Tidak ada rekomendasi", data: [], hasMore: false });
        }

        const allPerfumes = await getAllPerfumes();
        const matchedResults = matchMLNamesToDB(rawRecommendedNames, allPerfumes);

        // Ambil yang belum pernah dilihat (fresh)
        const freshMatches = matchedResults.filter(m => !history.has(m.perfume.id));

        const TARGET = 5;
        const finalMatches = freshMatches.slice(0, TARGET);

        // Masukkan ke history
        for (const m of finalMatches) {
            history.add(m.perfume.id);
        }

        const hasMore = freshMatches.length > TARGET;

        // UBAH: Karena halaman pertama nampilin 5, 
        // Jika history >= 5, berarti user klik "Lihat Lebih Banyak" pertama kalinya.
        // Kita anggap pencarian top match sudah habis, masuk ke alternatif.
        const isLowAccuracy = historySizeBefore >= 5;

        const responseData = finalMatches.map(m => m.perfume);

        return res.status(200).json({
            message: "Rekomendasi berhasil diambil",
            total: responseData.length,
            hasMore: hasMore,
            isLowAccuracy: isLowAccuracy, 
            data: responseData
        });

    } catch (error) {
        console.error("Error pada getRecommendations:", error.message);
        return res.status(500).json({ error: "Terjadi kesalahan saat mengambil rekomendasi." });
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