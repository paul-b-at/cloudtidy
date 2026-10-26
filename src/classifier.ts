import { extname } from 'node:path';
import { record, safeName, type Config } from './config';
import { run } from './process';
export interface Decision { route: string | null; suggestedName: string | null; needsReview: boolean; reason: string; tier: 'rules'|'apple'|'review' }
export const review = (reason: string): Decision => ({route:null,suggestedName:null,needsReview:true,reason,tier:'review'});
export function validateResult(raw: unknown, filename: string, config: Config): Decision {
 if(!record(raw) || raw.version!==1 || typeof raw.needsReview!=='boolean') return review('invalid_response');
 if(raw.needsReview || raw.route==='review') return review('model_uncertain');
 const route=config.routes.find(r=>r.id===raw.route);
 if(!route || !safeName(raw.suggestedName) || extname(raw.suggestedName).toLowerCase()!==extname(filename).toLowerCase()) return review('invalid_response');
 return {route:route.id,suggestedName:route.rename ? raw.suggestedName : filename,needsReview:false,reason:'model_suggestion_unverified',tier:'apple'};
}
export function heuristics(filename: string, text: string, config: Config): Decision | null {
 const input=`${filename}\n${text}`;
 const rules: [string,RegExp][] = [
  ['uni',/\b(?:VO|UE|KV|PR|SE|KS|PS)\s*\d{3}\.\d{3}\b/i],
  ['invoices',/\b(?:Rechnungsnummer|invoice number)\b/i],
  ['contracts',/\b(?:Mietvertrag|Versicherungspolizze)\b/i],
  ['personal',/\b(?:Reisepass|Boarding pass)\b/i]
 ];
 const hits=rules.filter(([id,regex])=>config.routes.some(r=>r.id===id) && regex.test(input));
 if(hits.length!==1) return null;
 const route=config.routes.find(r=>r.id===hits[0]![0])!;
 // A model can suggest invoice naming; do not invent dates/senders in rules.
 if(route.rename) return null;
 return {route:route.id,suggestedName:filename,needsReview:false,reason:'specific_rule_match',tier:'rules'};
}
export async function classify(filename: string, text: string, config: Config): Promise<Decision> {
 if(!safeName(filename)) return review('unsafe_filename');
 if(!text.trim()) return review('empty_text');
 const excerpt=text.slice(0,2400);
 const rule=heuristics(filename,excerpt,config); if(rule) return rule;
 try {
  const input={version:1,filename,text:excerpt,routes:config.routes.map(({id,description})=>({id,description}))};
  return validateResult(JSON.parse(await run(config.classifier,[],JSON.stringify(input),config.timeoutMs)),filename,config);
 } catch { return review('classifier_unavailable_or_failed'); }
}
