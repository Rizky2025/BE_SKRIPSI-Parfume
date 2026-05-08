const express = require('express');
const router = express.Router();
const perfumeController = require('../controllers/perfumeController');
const authController = require('../controllers/authController');
// Endpoint untuk frontend
router.post('/recommend',              perfumeController.getRecommendations);
router.post('/recommend/reset',        perfumeController.resetRecommendationHistory);
router.post('/favorites',              perfumeController.saveFavorite);       // simpan favorit
router.get('/favorites/:userId',       perfumeController.getUserFavorites);   // ambil favorit user
router.delete('/favorites/:favId',     perfumeController.deleteFavorite);     // hapus favorit
router.post('/login', authController.login);
router.post('/register', authController.register);
module.exports = router;