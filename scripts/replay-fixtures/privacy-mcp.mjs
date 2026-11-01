import fs from 'node:fs';
import readline from 'node:readline';
const [file,expected]=process.argv.slice(2);
const schema={type:'object',properties:Object.fromEntries(['type','id','name','signature','encrypted_content','data'].map(k=>[k,{type:'string'}])),required:['type','id','name','signature','encrypted_content','data']};
for await(const line of readline.createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);}catch{continue;}if(request.id===undefined)continue;
 let result;
 if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'privacy-fixture',version:'1'}};
 else if(request.method==='tools/list')result={tools:[{name:'echo',description:'Echo synthetic tool values for a privacy contract test.',inputSchema:schema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}]};
 else if(request.method==='tools/call'){
  const input=request.params.arguments||{};const valid=input.type==='thinking'&&['id','name','signature','encrypted_content','data'].every(k=>input[k]===expected);
  fs.writeFileSync(file,JSON.stringify({executed:true,valid,keys:Object.keys(input)})+'\n');result={isError:!valid,content:[{type:'text',text:valid?`MCP_EXECUTED:${expected}`:'MCP_INPUT_INVALID'}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
