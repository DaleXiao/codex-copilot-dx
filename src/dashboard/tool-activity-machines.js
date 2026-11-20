(() => {
  const fract = x => x - Math.floor(x);
  const clamp = x => Math.max(0, Math.min(1, x));
  const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const mix = (a,b,t) => a+(b-a)*t;
  const project = (x,y,z=0) => [x+y*.52,152+y*.36-z];
  const palette = (inkColor, paperColor) => {
    const sampler = document.createElement("canvas");sampler.width=1;sampler.height=1;
    const sample = sampler.getContext("2d",{willReadFrequently:true});
    const rgb = value => {
      sample.clearRect(0,0,1,1);sample.fillStyle=value;sample.fillRect(0,0,1,1);
      return [...sample.getImageData(0,0,1,1).data.slice(0,3)];
    };
    const ink = rgb(inkColor), paper = rgb(paperColor), colors = new Map();
    const tone = strength => {
      if (!colors.has(strength)) colors.set(strength, "rgb(" + paper.map((x,i) => Math.round(mix(x,ink[i],strength))).join(",") + ")");
      return colors.get(strength);
    };
    return { ink:inkColor,paper:paperColor,face:tone(.04),signal:inkColor,tone,
      stroke:tone(.66),shadow:tone(.10),base:tone(.32),top:tone(.13),side:tone(.25),end:tone(.39),edge:tone(.48) };
  };
  function poly(c,points,fill,stroke,width=1) {
    c.beginPath();c.moveTo(...points[0]);for(let i=1;i<points.length;i++)c.lineTo(...points[i]);
    if(fill){c.closePath();c.fillStyle=fill;c.fill();}
    if(stroke){c.lineWidth=width;c.strokeStyle=stroke;c.stroke();}
  }
  function ellipse(c,x,y,rx,ry,fill,stroke,width=1) {
    c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);
    if(fill){c.fillStyle=fill;c.fill();}
    if(stroke){c.lineWidth=width;c.strokeStyle=stroke;c.stroke();}
  }
  function beam(c,a,b,width,color) {
    c.lineCap="round";poly(c,[a,b],null,color,width);c.lineCap="butt";
  }
  function block(c,p,x,y,z,w,d,h,skin=p) {
    const a=project(x,y,z),f=project(x,y+d,z),g=project(x+w,y+d,z);
    const A=project(x,y,z+h),B=project(x+w,y,z+h),F=project(x,y+d,z+h),G=project(x+w,y+d,z+h);
    // The camera is above, in front of +Y and on the -X side.
    poly(c,[A,F,f,a],skin.end,p.stroke,.82);
    poly(c,[F,G,g,f],skin.side,p.stroke,.82);
    poly(c,[A,B,G,F],skin.top,p.stroke,.82);
    poly(c,[F,G],null,p.tone(.37),.72);
  }
  function plinth(c,p,x,y,w,d,h=4) {
    poly(c,[project(x-5,y+5),project(x+w+5,y+5),project(x+w+5,y+d+8),project(x-5,y+d+8)],p.shadow);
    block(c,p,x,y,0,w,d,h,{top:p.face,side:p.side,end:p.base});
  }
  function signal(c,p,x,y,z,live) {
    const [a,b]=project(x,y,z);
    ellipse(c,a,b,3.8,2.4,p.tone(.4));
    ellipse(c,a,b-.5,2.2,1.6,live?p.signal:p.tone(.60));
  }
  function roller(c,p,x,y,z,w,d) {
    block(c,p,x,y,z,w,d,8);
    const X=x+2,W=w-4;
    c.save();poly(c,[project(X,y,8+z),project(X+W,y,8+z),project(X+W,y+d,8+z),project(X,y+d,8+z)],p.tone(.19));c.clip();
    for(let a=x+5;a<x+w-3;a+=9){
      poly(c,[project(a,y+2,z+8),project(a,y+d-2,z+8)],null,p.tone(.45),2.7);
      poly(c,[project(a-.75,y+2,z+8),project(a-.75,y+d-2,z+8)],null,p.tone(.06),.85);
    }
    c.restore();
    for(const dy of [0,d-2])block(c,p,x,y+dy,z+8,w,2,2);
    for(const dx of [5,w-5]) {const [a,b]=project(x+dx,y+d,z+4);ellipse(c,a,b,1.8,1.8,p.ink,p.tone(.53),.5);}
  }
  // The rear plate goes behind the lane. The front plate and cap occlude
  // the lane, leaving a continuous aperture on the visible end.
  function beltGuard(c,p,x,y,length,depth,floor,ceiling,front) {
    if(!front){
      block(c,p,x,y,floor,length,3,ceiling-floor);
      return;
    }
    const edge=y+depth;
    block(c,p,x,edge-3,floor,length,3,ceiling-floor);
    block(c,p,x,y,ceiling,length,depth,3);
    const [a,b]=project(x+length*.54,edge,ceiling-5);
    ellipse(c,a,b,1.2,1.2,p.tone(.62));
  }
  const sweep = (q,start,end) => ease((q-start)/(end-start));
  function planeCircle(c,x,y,z,r,fill,stroke,width=1) {
    const [sx,sy]=project(x,y,z);
    c.save();c.transform(1,0,.52,.36,sx,sy);
    ellipse(c,0,0,r,r,fill,stroke,width);
    c.restore();
  }
  function cylinder(c,p,x,y,z,r,h,skin=p) {
    const near=Math.atan(.52);
    const rim=Array.from({length:13},(_,i)=>{
      const angle=near+i*Math.PI/12;
      return [x+r*Math.cos(angle),y+r*Math.sin(angle)];
    });
    const face=rim.map(([u,v])=>project(u,v,z+h));
    poly(c,[...face,...rim.reverse().map(([u,v])=>project(u,v,z))],skin.side,p.stroke,.8);
    planeCircle(c,x,y,z+h,r,skin.top,p.stroke,1.1);
  }
  function flange(c,p,x,y,z,width=24,shadow=true) {
    const half=width/2, depth=width*.32, h=6.5;
    const outline=[[-half,-depth+3],[-half+3,-depth],[half-3,-depth],[half,-depth+3],
      [half,depth-3],[half-3,depth],[-half+3,depth],[-half,depth-3]];
    const base=outline.map(([dx,dy])=>project(x+dx,y+dy,z));
    const top=outline.map(([dx,dy])=>project(x+dx,y+dy,z+h));
    const [sx,sy]=project(x,y,z);
    if(shadow)ellipse(c,sx+2,sy+1,half+3,depth*.48,p.shadow);
    for(const i of [7,6,5,4]){
      const j=(i+1)%outline.length;
      poly(c,[top[i],top[j],base[j],base[i]],p.tone(i===5?.56:.41),p.stroke,.65);
    }
    poly(c,top,p.tone(.07),p.tone(.77),.95);
    poly(c,[top[0],top[1],top[2],top[3]],null,p.paper,.85);
    poly(c,[top[7],top[6],top[5],top[4]],null,p.tone(.25),.8);
    const [cx,cy]=project(x,y,z+h);
    c.save();c.transform(1,0,.52,.36,cx,cy);
    ellipse(c,0,0,5,5,p.tone(.22),p.tone(.64),.8);
    ellipse(c,0,0,3.9,3.9,p.ink);
    for(const side of [-1,1]) {
      ellipse(c,side*(half-4),0,1.25,1.25,p.ink);
    }
    c.restore();
  }
  function assembly(c,p,t,running,reduced,layer) {
    const moving=running&&!reduced;
    const q=moving?fract(t/1.53):.93;
    const travel=sweep(q,.02,.37), step=108, pressX=174, lane=48, deck=29;
    const insertion=sweep(q,.56,.63);
    const pressTip=mix(72,40.5,sweep(q,.42,.56))-3*insertion
      +35*sweep(q,.68,.85);
    layer("base",c=>{
      plinth(c,p,11,4,353,82,5);
      for(const x of [51,110,239,305]){
        for(const y of [34,56])block(c,p,x,y,5,8,7,16);
      }
      for(const x of [16,329])beltGuard(c,p,x,27,28,44,5,44,false);
      roller(c,p,23,31,21,121,34);
      roller(c,p,204,31,21,144,34);
      // The lower die and the transfer guides share the conveyor deck height.
      block(c,p,140,31,13,68,34,16);
      for(const y of [31,63])block(c,p,141,y,29,67,2,2);
      block(c,p,145,34,5,59,27,8,{top:p.top,side:p.base,end:p.end});

      block(c,p,147,10,5,9,13,103);
      block(c,p,192,10,5,9,13,103);
      block(c,p,143,6,5,18,22,6);
      block(c,p,187,6,5,18,22,6);
      block(c,p,146,17,95,55,50,12);
      block(c,p,155,30,107,38,33,12,{top:p.face,side:p.base,end:p.end});
      block(c,p,167,42,69,14,12,26);
      for(const x of [155,193]){
        block(c,p,x,35,72,3,7,23);
        block(c,p,x,53,72,3,7,23);
      }
      poly(c,[project(192,24,111),project(198,24,111),project(202,31,105),
        project(202,45,104)],null,p.tone(.58),2.5);
      const hatch=Array.from({length:6},(_,i)=>151+i*8);
      for(const x of hatch)poly(c,[project(x,67,96),project(x+4,67,104)],null,p.tone(.48),1.1);
    });
    signal(c,p,187,53,119,moving&&q>.42&&q<.69);

    for(const i of [-1,0,1,2]){
      const x=pressX+(i+travel-1)*step;
      if(x<31||x>343)continue;
      flange(c,p,x,lane,deck,26);
      const lip=i>0?2:i===0?5-3*insertion:5;
      cylinder(c,p,x,lane,deck+6.5,5.5,lip,{top:p.tone(.07),side:p.edge,end:p.edge});
      planeCircle(c,x,lane,deck+6.5+lip,2.7,p.ink);
    }
    block(c,p,171,45,pressTip+3,6,6,78-(pressTip+3));
    block(c,p,164,40,pressTip,20,16,3,{top:p.top,side:p.end,end:p.base});
    layer("guard",c=>{
      for(const x of [16,329])beltGuard(c,p,x,27,28,44,5,44,true);
    });
  }
  function sorter(c,p,t,running,reduced,layer) {
    const moving=running&&!reduced, phase=moving?t*1.03:0;
    const pathY=x=>29+39*ease((x-152)/70);
    layer("base",c=>{
      plinth(c,p,16,5,334,84);
      for(const x of [37,138,248,310]){
        for(const y of [17,35])block(c,p,x,y,4,7,6,16);
      }
      for(const x of [224,269,310]){
        for(const y of [56,74])block(c,p,x,y,4,7,6,16);
      }
      for(const [x,y] of [[169,37],[195,54]])block(c,p,x,y,4,7,6,16);
      roller(c,p,23,15,20,309,28);
      // The transfer deck follows the polished guide path.
      const bars=Array.from({length:10},(_,i)=>151+8*i);
      const back=bars.map(x=>project(x,pathY(x)-12,28));
      const front=bars.map(x=>project(x,pathY(x)+12,28));
      const skirt=bars.map(x=>project(x,pathY(x)+12,20));
      poly(c,[...front,...skirt.reverse()],p.side,p.stroke,.85);
      poly(c,[...back,...front.slice().reverse()],p.tone(.21),p.stroke,.85);
      for(const x of bars){
        const y=pathY(x);
        poly(c,[project(x,y-10,28),project(x,y+10,28)],null,p.edge,2);
        poly(c,[project(x+.7,y-10,28),project(x+.7,y+10,28)],null,p.top,.75);
      }
      roller(c,p,211,54,20,121,28);
      block(c,p,118,9,4,6,9,71);
      block(c,p,118,46,4,6,9,71);
      block(c,p,114,10,75,15,45,7);
      block(c,p,119,21,66,8,24,9);
    });
    const idle=[.06,.23,.49,.65,.79,.92];
    const parts=idle.map((rest,i)=>{
      const q=moving?fract(phase+i/6):rest;
      const x=27+297*q;
      const y=i%2?pathY(x):29;
      return {x,y,q};
    });
    const scanned=parts.some(part=>Math.abs(part.x-122)<13);
    const divert=parts.reduce((s,part,i)=>i%2?Math.max(s,
      ease((part.x-143)/13)*ease((206-part.x)/15)):s,0);
    const pivot=project(152,41,38),tip=project(152+29*divert,41-16*divert,38);
    block(c,p,149,38,22,6,6,16);
    beam(c,pivot,tip,4,p.tone(.36));beam(c,pivot,tip,1,p.tone(.77));
    parts.sort((a,b)=>a.y-b.y||a.x-b.x).forEach(({x,y,q})=>{
      c.globalAlpha=moving?Math.min(ease(q/.047),ease((1-q)/.054)):1;
      flange(c,p,x,y,28);
    });
    c.globalAlpha=1;
    signal(c,p,123,33,82,running&&scanned);
    if(moving&&scanned)poly(c,[project(122,18,35),project(122,39,35)],null,p.signal,1.05);
    for(const y of [15,54]){
      block(c,p,324,y+25,20,7,3,13);
      signal(c,p,327,y+26.5,33,moving&&parts.some(part=>part.x>303&&Math.abs(part.y-y-14)<9));
    }
  }
  function gantry(c,p,t,running,reduced,layer) {
    const moving=running&&!reduced;
    const q=moving?fract(t/1.53):.01;
    const from=94,to=267,lane=51,deck=29;
    const clear=79,pick=43;
    const carriageX=from+(to-from)*(sweep(q,.34,.60)-sweep(q,.86,1));
    const carriageZ=clear-(clear-pick)*(sweep(q,.025,.18)-sweep(q,.23,.34)
      +sweep(q,.60,.71)-sweep(q,.77,.86));
    const grasp=sweep(q,.18,.23)-sweep(q,.72,.77);
    const held=q>=.23&&q<.72;
    const partZ=carriageZ-(pick-deck), feed=sweep(q,.33,.92), sent=sweep(q,.79,1);
    layer("base",c=>{
      plinth(c,p,11,4,351,84,5);
      for(const x of [54,303]) {
        block(c,p,x-6,9,5,25,24,6);
        block(c,p,x,13,11,13,16,93);
        poly(c,[project(x+1,29,32),project(x+21,29,11),project(x+1,29,11)],p.side,p.stroke,.8);
      }
      for(const x of [45,98,257,312]){
        for(const y of [38,59])block(c,p,x,y,5,8,6,16);
      }
      for(const x of [17,329])beltGuard(c,p,x,32,25,40,5,39,false);
      roller(c,p,27,35,21,93,32);
      roller(c,p,241,35,21,107,32);
    });
    if(held) {
      // The load casts its shadow onto the bed or onto the lower machine base.
      const surface=carriageX<119||carriageX>245?deck:5;
      const [x,y]=project(carriageX,lane,surface);
      ellipse(c,x+2,y,13,3.8,p.shadow);
    }
    if(q<.23)flange(c,p,from,lane,deck,21);
    for(const x of [from-41+41*feed,from-82+41*feed]){
      if(x>=30)flange(c,p,x,lane,deck,21);
    }
    if(q>=.72&&to+91*sent<342)flange(c,p,to+91*sent,lane,deck,21);

    layer("beam",c=>{
      block(c,p,48,20,100,273,34,13);
      for(const z of [103,109]) {
        poly(c,[project(52,54,z),project(317,54,z)],null,p.tone(.60),1.5);
      }
      for(let x=66;x<316;x+=19){
        const [a,b]=project(x,54,106);
        ellipse(c,a,b,1.3,1.3,p.tone(.68));
      }
    });
    const cable=[project(315,38,116),project(carriageX+20,38,116),
      project(carriageX+14,38,113),project(carriageX+10,38,108)];
    poly(c,cable,null,p.tone(.43),3.4);
    poly(c,cable,null,p.tone(.69),.85);
    block(c,p,carriageX-10,32,90,20,25,19,{top:p.face,side:p.base,end:p.end});
    block(c,p,carriageX-3,47,carriageZ+3,6,8,90-carriageZ-3);
    block(c,p,carriageX-11,44,carriageZ,22,14,4);
    if(held)flange(c,p,carriageX,lane,partZ,21,false);
    for(const sign of [-1,1]){
      const jawX=carriageX+sign*mix(14.5,11.8,grasp);
      block(c,p,jawX-1.3,46,carriageZ-12,2.6,10,12);
    }
    layer("guard",c=>{
      for(const x of [17,329])beltGuard(c,p,x,32,25,40,5,39,true);
    });
    signal(c,p,306,39,113,held&&moving);
  }
  function rotary(c,p,t,running,reduced,layer) {
    const moving=running&&!reduced;
    const phase=moving?t/1.04:.32;
    const u=fract(phase), stationAngle=Math.PI/3;
    const angle=(Math.floor(phase)+sweep(u,.015,.29))*stationAngle;
    const centerX=180,centerY=53,orbit=53,tableTop=33;
    const position=a=>[centerX+orbit*Math.cos(a),centerY+orbit*Math.sin(a)];
    const heads=[4,5].map(i=>position(i*stationAngle));
    layer("base",c=>{
      plinth(c,p,76,-40,213,171,5);
      for(const [x,y] of heads){
        block(c,p,x-14,y-46,5,28,18,6);
        block(c,p,x-9,y-41,11,18,12,84);
        block(c,p,x-11,y-41,83,22,51,11);
        poly(c,[project(x+7,y-41,90),project(x+12,y-41,100),
          project(x+12,y+4,100),project(x+9,y+8,93)],null,p.tone(.55),2);
      }
      cylinder(c,p,centerX,centerY,5,44,14,{top:p.top,side:p.base,end:p.base});
      cylinder(c,p,centerX,centerY,19,74,14,{top:p.tone(.14),side:p.end,end:p.end});
      planeCircle(c,centerX,centerY,tableTop,67,null,p.tone(.45),.8);
    });
    // Each workpiece and its fixture share the same angle and height.
    const sockets=Array.from({length:6},(_,i)=>position(angle+i*stationAngle));
    sockets.sort((a,b)=>a[1]-b[1]);
    for(const [x,y] of sockets){
      cylinder(c,p,x,y,tableTop,14,4,{top:p.tone(.27),side:p.end,end:p.end});
      cylinder(c,p,x,y,tableTop+4,10,6,{top:p.tone(.07),side:p.edge,end:p.edge});
      planeCircle(c,x,y,tableTop+10,6.6,p.tone(.25),p.tone(.54),.65);
      planeCircle(c,x,y,tableTop+10,4.7,p.ink);
    }
    cylinder(c,p,centerX,centerY,tableTop,15,5,{top:p.top,side:p.edge,end:p.edge});
    const indicator=angle+Math.PI*.14;
    for(const [lo,hi] of [[17,41],[65,72]]){
      const at=r=>project(centerX+r*Math.cos(indicator),centerY+r*Math.sin(indicator),tableTop+.1);
      poly(c,[at(lo),at(hi)],null,p.stroke,1.1);
    }
    heads.forEach(([x,y],i)=>{
      const offset=i*.07;
      const stroke=sweep(u,.39+offset,.54+offset)-sweep(u,.67+offset,.82+offset);
      const tip=mix(65,tableTop+10,stroke);
      block(c,p,x-6,y-6,67,12,12,18,{top:p.face,side:p.base,end:p.end});
      cylinder(c,p,x,y,tip+3,2.5,69-tip,{top:p.face,side:p.edge,end:p.edge});
      cylinder(c,p,x,y,tip,6,3,{top:p.top,side:p.end,end:p.end});
      signal(c,p,x+5,y+5,85,moving&&stroke>.85);
    });
  }
  const scenes={assembly,sorter,gantry,rotary};
  globalThis.ccdxToolMachines = context => {
    const layers = new Map();
    let identity, colors;
    return (style, { time, running, reduced, width, height, dpr, ink, surface }) => {
      const scale = Math.min(width / 420, height / 202);
      const transform = [scale * dpr, 0, 0, scale * dpr, (width - 420 * scale) * dpr / 2, (height - 202 * scale) * dpr / 2];
      const next = [style, width, height, dpr, ink, surface].join("|");
      if (identity !== next) {
        identity = next;layers.clear();colors = palette(ink, surface);
      }
      context.setTransform(...transform);
      const layer = (key, paint) => {
        let bitmap = layers.get(key);
        if (!bitmap) {
          bitmap = document.createElement("canvas");
          bitmap.width = context.canvas.width;bitmap.height = context.canvas.height;
          const buffer = bitmap.getContext("2d");buffer.setTransform(...transform);paint(buffer);
          layers.set(key, bitmap);
        }
        context.save();context.setTransform(1, 0, 0, 1, 0, 0);context.drawImage(bitmap, 0, 0);context.restore();
      };
      scenes[style](context, colors, time, running, reduced, layer);
    };
  };
})();
