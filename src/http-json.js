// Bound upload time as well as bytes before reserving any shared draft work.
export async function readJsonBody(req,{maxBytes=12000,timeoutMs=5000}={}){
 const timer=setTimeout(()=>req.destroy(Error('Request body timed out')),timeoutMs);
 try{
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Error('Request is too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }finally{clearTimeout(timer);}
}
