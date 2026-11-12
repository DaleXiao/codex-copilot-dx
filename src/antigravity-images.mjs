import {nativeImageRequest,checkedImage,IMAGE_MAX_BYTES} from "./native-images.mjs";
import {imageModelCatalog,imageModelSelection} from "./image-models.mjs";
import {httpError,readBoundedResponseText} from "./http-transport.mjs";

export function createAntigravityImages({client,models,privacy}={}) {
  return async(request,{signal}={})=>{
    const parts=(request?.contents||[]).flatMap(item=>item.parts||[]),text=[],images=[];
    for(const part of parts){
      if(typeof part.text==="string")text.push(part.text);
      else if(part.inlineData&&/^image\//.test(part.inlineData.mimeType||""))images.push({image_url:"data:"+part.inlineData.mimeType+";base64,"+part.inlineData.data});
      else throw httpError("Unsupported Antigravity image input",400);
    }
    const available=imageModelCatalog(models()),selected=imageModelSelection(available).selected_model;
    if(!selected)throw httpError("No Copilot image model is available",503);
    const operation=images.length?"edits":"generations";
    if(images.length&&!available.find(model=>model.id===selected)?.editing)throw httpError("The Copilot image model does not support editing",400);
    const body=await nativeImageRequest({model:selected,prompt:text.join("\n"),...(images.length?{images}:{}),n:1},operation,selected);
    const session=privacy?.prepareSession?await privacy.prepareSession({input:body.prompt},{protocol:"responses",client:"gemini",signal}):null;
    try{
      const response=await client.images(operation,{...body,prompt:session?.body.input||body.prompt},{signal});
      if(!response.ok){await response.body?.cancel();throw httpError("Copilot image generation was refused (HTTP "+response.status+")",response.status)}
      const value=JSON.parse(await readBoundedResponseText(response,{maxBytes:48*1024*1024,signal,label:"Copilot image"}));
      if(!Array.isArray(value.data)||value.data.length!==1)throw httpError("Invalid Copilot image response",502);
      const data=value.data[0].b64_json,mimeType=await checkedImage(data,IMAGE_MAX_BYTES);
      return {candidates:[{index:0,content:{role:"model",parts:[{inlineData:{mimeType,data}}]},finishReason:"STOP"}]};
    }finally{session?.release()}
  };
}
