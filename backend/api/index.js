// api/index.js
const app = require('../index');
const { connectToDatabase } = require('../utils/db');

module.exports = async (req, res) => {
  await connectToDatabase();
  return app(req, res);
};