import { createAgent, listAgentTools } from '../agent/tools.mjs';
import { launchOptions, readArguments } from '../agent/options.mjs';
import { agentError, publicError } from '../agent/client.mjs';

try{
  const {baseUrl,positionals,inputFile}=launchOptions(process.argv.slice(2));
  const agent=createAgent({baseUrl});
  const [command='list',tool,...extra]=positionals;
  if(extra.length||(command==='list'&&(tool||inputFile))||!['list','call'].includes(command)||(command==='call'&&!tool))throw agentError('INVALID_INPUT','用法：agent-cli.mjs [--url http://127.0.0.1:4318] list | call <tool> [--input args.json]');
  const output=command==='list'?{ok:true,tools:listAgentTools()}:{ok:true,tool,result:await agent.execute(tool,await readArguments(inputFile))};
  process.stdout.write(JSON.stringify(output)+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({ok:false,error:publicError(error)})+'\n');
  process.exitCode=1;
}
