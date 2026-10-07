import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFINITIONS, createAgent } from './tools.mjs';
import { publicError } from './client.mjs';

export function createAgentMcpServer(options={}){
  const agent=createAgent(options);
  const server=new McpServer({name:'aiframe-studio',version:'0.1.0'},{instructions:'映序是本机小说短剧工作台。生成工具可能计费，重复调用默认复用同版素材和当前任务。收到未知提交状态时读取任务或恢复查询，不要盲目重发。审核必须实际检查图片，并显式传 reviewedVersion；图片生成完成不代表已获用户视频审核。凭据仅在应用中配置，本 MCP 不接收或返回 API 密钥。'});
  for(const tool of TOOL_DEFINITIONS){
    server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema,annotations:tool.annotations},async args=>{
      try{
        const value={ok:true,result:await agent.execute(tool.name,args)};
        return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      }catch(error){
        const value={ok:false,error:publicError(error)};
        return {isError:true,content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      }
    });
  }
  return server;
}
