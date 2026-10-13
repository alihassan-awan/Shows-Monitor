import { handleTelegramTest } from '../../src/handlers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await handleTelegramTest(req, res);
}
