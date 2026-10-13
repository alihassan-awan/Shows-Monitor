import { handleCronCheck } from '../../src/handlers.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await handleCronCheck(req, res);
}
