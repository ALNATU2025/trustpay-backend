'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { getConfig, presentCatalog } = require('../services/catalog');

const router = express.Router();

// Public on purpose: nothing here is private, and the app can preload it.
router.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(presentCatalog(await getConfig()));
  }),
);

module.exports = router;
