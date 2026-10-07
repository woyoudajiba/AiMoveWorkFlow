import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentMcpServer } from '../agent/mcp.mjs';
import { launchOptions } from '../agent/options.mjs';
import { publicError } from '../agent/client.mjs';

try{
  const {baseUrl}=launchOptions(process.argv.slice(2),{mcp:true});
  const server=createAgentMcpServer({baseUrl});
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:1024*1024});
  await server.connect(transport);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void server.close().finally(()=>process.exit(0));});
}catch(error){
  // Standard output belongs exclusively to the SDK's JSON-RPC transport.
  process.stderr.write(JSON.stringify({ok:false,error:publicError(error)})+'\n');
  process.exitCode=1;
}
