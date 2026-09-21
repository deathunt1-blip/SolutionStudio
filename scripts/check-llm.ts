import 'dotenv/config';
// No document content or credentials are logged by this connectivity check.
const baseUrl=process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1';
const key=process.env.LLM_API_KEY;
if(!key) throw new Error('Configure LLM_API_KEY in .env');
const response=await fetch(`${baseUrl}/chat/completions`,{
  method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:process.env.LLM_MODEL || 'kimi-k2.6',messages:[{role:'user',content:'Return only a JSON object with an ok field set to true.'}],temperature:0.6,max_tokens:1000,thinking:{type:'disabled'}}),
  signal:AbortSignal.timeout(60000)
});
const data=await response.json() as {choices?:{message:{content:string}}[];error?:{message:string}};
console.log(JSON.stringify({status:response.status,reply:data.choices?.[0]?.message.content,error:response.ok?undefined:'Provider request failed; check endpoint/model/credentials.'}));
