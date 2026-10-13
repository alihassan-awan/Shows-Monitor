import { handleMeta } from '../src/handlers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await handleMeta(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
