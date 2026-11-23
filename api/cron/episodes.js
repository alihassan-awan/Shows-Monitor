import { checkEpisodes } from '../../src/episodes.js';
export const config = { maxDuration: 60 };
export default async function handler(req,res) {
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  const secret=process.env.CRON_SECRET;
  if(!secret || req.headers.authorization!==`Bearer ${secret}`) return res.status(401).json({error:'Unauthorized'});
  try { return res.status(200).json(await checkEpisodes()); }
  catch(e) { console.error('[episodes]',e); return res.status(500).json({error:e.message}); }
}
