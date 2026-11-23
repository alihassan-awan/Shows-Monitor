import { handleEpisodes } from '../src/handlers.js';
export default async function handler(req,res) {
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  return handleEpisodes(req,res);
}
