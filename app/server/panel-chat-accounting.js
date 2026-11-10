// These are links and response summaries, never additional ledger amounts.
export function recordGatewaySession(session,response,{streamId,at=Date.now()}){
 const id=response.headers?.get('X-Hermes-Session-Id');
 if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)||id.includes('..'))return false;
 const links=Array.isArray(session.gateway_usage_sessions)?session.gateway_usage_sessions:[];
 const existing=links.find(row=>row.id===id);
 if(existing){existing.last_seen=at;existing.last_stream_id=streamId;}
 else links.push({id,first_seen:at,last_seen:at,last_stream_id:streamId,source:'gateway_response_header'});
 session.gateway_usage_sessions=links;return true;
}
export function usageSummary(usage,{provider,at=Date.now()}={}){
 const result={reported_at:at,scope:'gateway_response',requested_model:provider?.model||null,requested_provider:provider?.gatewayProvider||null};
 for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(usage?.[key])&&usage[key]>=0)result[key]=usage[key];
 return result;
}
