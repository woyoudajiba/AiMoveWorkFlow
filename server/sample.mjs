export const SAMPLE_INPUT = {
  title: '雨停之前', duration: 30, aspectRatio: '9:16', style: '写实电影，雨夜暖色书店与冷色街道，克制而温柔',
  novel: '雨落在旧书店的玻璃上。林遥推开门，蓝色外套的肩头湿了一片。柜台后的陈默抬起头，认出了离开小城五年的朋友。\n“你还留着？”林遥看向柜台上那本旧诗集。陈默把夹在书页里的车票推到她面前：“有人说，等雨停了就回来。”\n林遥拿起车票，笑着看向窗外。雨渐渐停了。陈默关掉柜台灯，两个人并肩走到门口。',
};
export const SAMPLE_ANALYSIS = {
  characters: [
    { id: 'lin-yao', name: '林遥', role: 'protagonist', aliases: [], appearance: '青年女性，黑色及肩发，自然妆容；待确认创作设定。', evidence: '林遥推开门，蓝色外套的肩头湿了一片。' },
    { id: 'chen-mo', name: '陈默', role: 'supporting', aliases: [], appearance: '原文未描述外貌。创作设定待确认：青年男性，黑色短发，米色针织衫。', evidence: '柜台后的陈默抬起头，认出了离开小城五年的朋友。' },
  ],
  scenes:[{id:'bookstore-night',name:'雨夜旧书店',description:'从林遥推门至两人离开门口的连续场景，两人保持原造型。'}],
  looks:[
    {id:'lin-yao-bookstore',sceneId:'bookstore-night',characterId:'lin-yao',name:'雨夜蓝外套',appearance:'蓝色外套肩头淋湿，黑色及肩发略湿。原文未写其他服饰，细节待确认。'},
    {id:'chen-mo-bookstore',sceneId:'bookstore-night',characterId:'chen-mo',name:'书店日常造型',appearance:'原文未交代服装。待确认设定：米色针织衫、深色长裤，黑色短发。'},
  ],
  segments: [{ title: '旧书店重逢', summary: '这是固定离线示例分镜，用于熟悉流程，未调用任何模型。', duration: 30, shots: [
    { scene: '雨夜书店外', action: '雨水沿玻璃缓缓滑落，暖灯映出书架', camera: '环境远景，缓慢推进', dialogue: '', characterIds: [], duration: 3 },
    { scene: '书店门口', action: '林遥推门进来，停下脚步', camera: '中景，平视', dialogue: '', characterIds: ['lin-yao'], duration: 3 },
    { scene: '书店柜台', action: '陈默抬头认出门口的人', camera: '近景，固定镜头', dialogue: '', characterIds: ['chen-mo'], duration: 3 },
    { scene: '柜台前', action: '林遥看见旧诗集，轻轻开口', camera: '林遥半身近景', dialogue: '你还留着？', characterIds: ['lin-yao'], duration: 4 },
    { scene: '书店柜台', action: '陈默从书页间取出一张旧车票', camera: '手部与诗集特写', dialogue: '', characterIds: ['chen-mo'], duration: 3 },
    { scene: '柜台前', action: '陈默把车票推到林遥面前', camera: '双人中景，轻微推进', dialogue: '有人说，等雨停了就回来。', characterIds: ['lin-yao', 'chen-mo'], duration: 4 },
    { scene: '柜台前', action: '林遥拿起车票，露出释然的笑容', camera: '林遥面部近景', dialogue: '', characterIds: ['lin-yao'], duration: 3 },
    { scene: '书店窗边', action: '窗外雨停，积水倒映温暖灯光', camera: '窗外环境特写', dialogue: '', characterIds: [], duration: 3 },
    { scene: '书店门口', action: '两人并肩停在门口，望向安静的街道', camera: '背影中远景，缓慢拉远', dialogue: '', characterIds: ['lin-yao', 'chen-mo'], duration: 4 },
  ].map(shot=>({...shot,sceneId:'bookstore-night'})) }],
};
