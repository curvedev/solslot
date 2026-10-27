import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createLeverGesture } from './lever-gesture.js';
import { SYMBOLS, outcomeSymbols } from '../web-source/symbols.js';

export const LEVER_LAYOUT = Object.freeze({ x: 2.30, y: -.53, z: 1.06, length: 1.72, radius: .29 });
export function slotCameraFrame(width, height, visibleWidth = width) {
  const x = .32, y = .05;
  const halfView = Math.max(1, Math.min(width, visibleWidth) / 2 - 14);
  // Fit the lever's entire forward arc, including the knob and touch ring.
  const closestZ = LEVER_LAYOUT.z + LEVER_LAYOUT.length + LEVER_LAYOUT.radius;
  const rightEdge = LEVER_LAYOUT.x + LEVER_LAYOUT.radius;
  const z = Math.max(9.8, closestZ + (rightEdge - x) * height / (2 * Math.tan(35 * Math.PI / 360) * halfView));
  return { x, y, z };
}

// A visual presentation only. All outcomes come from the existing game engine.
export function createJackpotWorld(container, onPlay, {demo = true} = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.035);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.72;
  room.dispose(); pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
  const target = new THREE.Vector3(.32, .05, 0);
  const hemi = new THREE.HemisphereLight(0xe7f5ff, 0xcd8665, 1.5); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff6df, 2.3); key.position.set(-4, 7, 7); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 6; key.shadow.camera.bottom = -6; key.shadow.bias = -0.001;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.7); rim.position.set(5, 4, -3); scene.add(rim);
  const machine = new THREE.Group(); scene.add(machine);
  const mat = (color, metalness = 0, roughness = 0.32) => new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 0.8, clearcoatRoughness: 0.18 });
  const orange = mat(0xee6938, 0.28, 0.25), gold = mat(0xe9b563, 0.78, 0.24), cream = mat(0xfff3d9, 0.06, 0.24), dark = mat(0x29403d, 0.22, 0.26), chrome = mat(0xece2c8, 0.9, 0.17);
  const rounded = (w,h,d,r, material,x,y,z, parent=machine) => {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w,h,d,4,r), material);
    mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
  };
  const cylinder = (radius,height,material,x,y,z,parent=machine) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,64), material);
    mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
  };
  const bodyShell=rounded(3.42,4.1,1.5,.24,orange,0,.07,0);
  rounded(3.58,.28,1.72,.12,gold,0,-1.94,.05);
  rounded(3.19,3.80,.18,.18,gold,0,.09,.78);
  const frontPanel=rounded(3.00,3.62,.17,.14,cream,0,.10,.89);
  rounded(3.54,1.19,.46,.26,gold,0,1.81,.88);
  rounded(3.26,.98,.19,.20,orange,0,1.81,1.12);
  const displayMaterial=new THREE.MeshBasicMaterial({color:0x142d29,toneMapped:false});
  rounded(2.98,.78,.08,.15,displayMaterial,0,1.81,1.24);
  rounded(3.00,1.40,.15,.12,gold,0,.46,1.02);
  rounded(2.84,1.25,.09,.09,dark,0,.46,1.13);
  rounded(2.94,.17,.20,.065,gold,0,-.32,1.05);

  function canvasTexture(width,height) {
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas rendering is unavailable.');
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),4);
    return {canvas,ctx,texture};
  }
  function screen(texture,w,h,x,y,z) {
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:texture,transparent:true,toneMapped:false}));mesh.position.set(x,y,z);machine.add(mesh);return mesh;
  }
  const jackpot=canvasTexture(1024,300);
  screen(jackpot.texture,2.77,.71,0,1.81,1.29);
  let lastPot=null;
  function updatePot(pot, usd='—', quoteLabel='USD UNAVAILABLE', historical=false) {
    const key=JSON.stringify([pot,usd,quoteLabel,historical]);if(key===lastPot)return;lastPot=key;
    const c=jackpot.ctx;c.clearRect(0,0,1024,300);c.textAlign='center';
    c.fillStyle='#e5dab6';c.font='500 30px Arial';c.fillText(historical?'LAST JACKPOT':'CURRENT JACKPOT',512,48);
    const fitted=(text,x,width)=>{let size=76;do{c.font=`bold ${size}px Arial`;size-=2;}while(c.measureText(text).width>width&&size>22);c.fillText(text,x,151);};
    c.shadowColor='#ffbd54';c.shadowBlur=10;c.fillStyle='#ffe5a0';fitted(Number.isFinite(pot)?pot.toFixed(historical?6:3):'—',270,425);fitted(usd,769,420);
    c.shadowBlur=0;c.font='28px Arial';c.fillStyle='#e5dab6';c.fillText('SOL',270,196);c.fillText('≈ USD',769,196);
    c.strokeStyle='#c9a66055';c.lineWidth=2;c.beginPath();c.moveTo(523,83);c.lineTo(523,207);c.stroke();
    c.font='23px Arial';c.fillStyle='#c8d6ce';c.fillText((historical?'GAME CLOSED':demo?'DEMO POOL':'CREATOR-FEE POOL')+' · '+quoteLabel,512,265);jackpot.texture.needsUpdate=true;
  }
  const labels=canvasTexture(1024,360);
  let style='signature';
  const palettes={
    signature:{body:0xd74316,trim:0xeebc63,face:0x8c2817,dark:0x312421,chrome:0xe5bc79,label:'#fff0cd',reel:'#fff5dc',display:0x172f29,light:0xffd079},
    midnight:{body:0x12212b,trim:0xb99557,face:0x14212d,dark:0x08121c,chrome:0xc9b889,label:'#ebd5a4',reel:'#f1e9d4',display:0x080f19,light:0xffdd97},
    cloud:{body:0xe0eaf1,trim:0xb8c9d4,face:0xf2f6fa,dark:0x375d70,chrome:0xe1f1ff,label:'#365166',reel:'#f7fbff',display:0x173a49,light:0x99e5ff}
  };
  function paintLabels(){
    const c=labels.ctx;c.clearRect(0,0,1024,360);c.textAlign='center';c.fillStyle=palettes[style].label;
    c.font='bold 55px Arial';c.fillText('S O L P O T',512,85);
    c.font='30px Arial';c.fillText('THREE LOGOS. THE WHOLE POT.',512,164);
    c.globalAlpha=.75;c.font='26px Arial';c.fillText('200K ENTRY  /  1 IN 100',512,225);c.globalAlpha=1;labels.texture.needsUpdate=true;
  }
  paintLabels();
  screen(labels.texture,2.7,.77,0,-.82,1.11);
  const reels=[];const symbolImages=[];
  for(let i=0;i<3;i++) {
    rounded(.89,1.14,.11,.06,cream,(i-1)*.94,.46,1.20);
    const panel=canvasTexture(256,360);screen(panel.texture,.83,1.08,(i-1)*.94,.46,1.265);reels.push(panel);
  }
  function paintSymbol(c,index,y) {
    const symbol=SYMBOLS[index];
    const img=symbolImages[index];
    if(img){const size=index===0?235:190,scale=Math.min(size/img.naturalWidth,size/img.naturalHeight);const w=img.naturalWidth*scale,h=img.naturalHeight*scale;c.save();c.drawImage(img,128-w/2,y-h/2,w,h);c.restore();}
    else {c.fillStyle=symbol.color;c.font=index===0?'900 205px Arial':'900 190px Georgia';c.fillText(symbol.text,128,y);}
  }
  function paintReel(i,glyph,offset=0,animated=false) {
    const {ctx:c,texture}=reels[i];c.clearRect(0,0,256,360);c.fillStyle=palettes[style].reel;c.fillRect(0,0,256,360);
    c.textAlign='center';c.textBaseline='middle';
    if(animated){for(let j=-2;j<3;j++){const idx=((glyph+j)%SYMBOLS.length+SYMBOLS.length)%SYMBOLS.length;paintSymbol(c,idx,180+j*300+offset);}}
    else paintSymbol(c,glyph,182);
    const shade=c.createLinearGradient(0,0,0,360);shade.addColorStop(0,'rgba(66,42,13,.21)');shade.addColorStop(.16,'rgba(255,255,255,0)');shade.addColorStop(.75,'rgba(255,255,255,0)');shade.addColorStop(1,'rgba(66,42,13,.20)');c.fillStyle=shade;c.fillRect(0,0,256,360);texture.needsUpdate=true;
  }
  let symbols=[4,1,0];symbols.forEach((n,i)=>paintReel(i,n));
  const buttonPlate=cylinder(.39,.14,gold,.72,-1.39,1.17);buttonPlate.rotation.x=Math.PI/2;
  const playButton=cylinder(.32,.16,orange,.72,-1.39,1.29);playButton.rotation.x=Math.PI/2;
  const buttonText=canvasTexture(256,256);buttonText.ctx.textAlign='center';buttonText.ctx.textBaseline='middle';buttonText.ctx.fillStyle='#fff6dc';buttonText.ctx.font='bold 48px Arial';buttonText.ctx.fillText('200K',128,132);buttonText.texture.needsUpdate=true;screen(buttonText.texture,.51,.51,.72,-1.39,1.39);
  rounded(.86,.31,.08,.08,gold,-.78,-1.41,1.1);rounded(.60,.053,.10,.022,dark,-.78,-1.41,1.16);
  const leverMount=cylinder(.13,.66,gold,1.99,LEVER_LAYOUT.y,LEVER_LAYOUT.z);leverMount.rotation.z=Math.PI/2;
  const lever=new THREE.Group();lever.position.set(LEVER_LAYOUT.x,LEVER_LAYOUT.y,LEVER_LAYOUT.z);machine.add(lever);
  const joint=new THREE.Mesh(new THREE.SphereGeometry(.24,24,16),gold);lever.add(joint);
  cylinder(.07,1.75,chrome,0,.78,0,lever);
  const knob=new THREE.Mesh(new THREE.SphereGeometry(LEVER_LAYOUT.radius,32,24),orange);knob.position.set(0,LEVER_LAYOUT.length,0);knob.castShadow=true;lever.add(knob);
  const lights=[];
  for(let i=0;i<9;i++) {
    const light=new THREE.Mesh(new THREE.SphereGeometry(.052,12,10),new THREE.MeshStandardMaterial({color:0xffefb1,emissive:0xffc443,emissiveIntensity:.4,roughness:.25}));
    light.position.set(-1.41+i*.353,2.26,1.01);machine.add(light);lights.push(light);
  }
  const platform=cylinder(2.34,.29,mat(0xeccf9f,.3,.37),0,-2.30,0,scene);
  const platformTop=cylinder(2.18,.09,mat(0xffe8bd,.15,.4),0,-2.11,0,scene);
  const rock=new THREE.Mesh(new THREE.IcosahedronGeometry(1.72,0),mat(0xb9a78f,0,.9));rock.scale.set(1.18,.77,1.03);rock.rotation.z=.12;rock.position.set(0,-3.0,-.12);scene.add(rock);
  const rockTip=new THREE.Mesh(new THREE.IcosahedronGeometry(.85,0),mat(0xa89985,0,.95));rockTip.scale.set(.68,1.25,.77);rockTip.position.set(.28,-3.69,0);scene.add(rockTip);
  rock.visible=false;rockTip.visible=false;
  const styleGroups={signature:new THREE.Group(),midnight:new THREE.Group(),cloud:new THREE.Group()};
  Object.values(styleGroups).forEach(group=>machine.add(group));
  // Sculpted side rails and a stepped pedestal distinguish the cabinets.
  for(const x of [-1.65,1.65]) {
    rounded(.15,3.65,.30,.065,gold,x,.09,.91,styleGroups.signature);
    rounded(.24,.30,.36,.065,gold,x,-1.77,.92,styleGroups.signature);
    for(let j=0;j<3;j++) rounded(.045,3.64,.18,.015,gold,x+(j-1)*.075,.08,.93,styleGroups.midnight);
    rounded(.30,3.20,.64,.145,chrome,x,.02,.59,styleGroups.cloud);
  }
  rounded(3.63,.20,1.83,.08,dark,0,-2.04,.06,styleGroups.midnight);
  rounded(3.72,.13,1.91,.06,gold,0,-2.16,.06,styleGroups.midnight);
  for(const [x,h] of [[-.49,.17],[0,.29],[.49,.17]]) rounded(.46,h,.34,.035,gold,x,2.44+h/2,.70,styleGroups.midnight);
  rounded(3.35,.14,.38,.06,gold,0,2.40,.79,styleGroups.signature);
  const haloMaterial=new THREE.MeshStandardMaterial({color:0xcceeff,emissive:0x7bc6e0,emissiveIntensity:.6,metalness:.65,roughness:.2});
  const halo=new THREE.Mesh(new THREE.TorusGeometry(2.28,.045,12,100),haloMaterial);halo.position.set(0,.12,-.62);styleGroups.cloud.add(halo);
  rounded(3.52,.16,1.80,.075,chrome,0,-2.06,.05,styleGroups.cloud);
  const bodyShapes={signature:bodyShell.geometry,midnight:new RoundedBoxGeometry(3.42,4.1,1.5,4,.10),cloud:new RoundedBoxGeometry(3.42,4.1,1.5,5,.38)};
  function setStyle(value){
    if(!palettes[value])return;style=value;const p=palettes[style];
    orange.color.setHex(p.body);gold.color.setHex(p.trim);cream.color.setHex(p.face);dark.color.setHex(p.dark);chrome.color.setHex(p.chrome);displayMaterial.color.setHex(p.display);
    bodyShell.geometry=bodyShapes[style];frontPanel.material=cream;
    for(const [id,group] of Object.entries(styleGroups))group.visible=id===style;
    lights.forEach(light=>{light.material.color.setHex(p.light);light.material.emissive.setHex(p.light);});
    const bc=buttonText.ctx;bc.clearRect(0,0,256,256);bc.fillStyle=style==='cloud'?'#365166':'#fff6dc';bc.fillText('200K',128,132);buttonText.texture.needsUpdate=true;
    paintLabels();symbols.forEach((symbol,index)=>paintReel(index,symbol));container.dataset.machineStyle=style;requestFrame();
  }
  const coins=[];
  const coinFace=canvasTexture(256,256);coinFace.ctx.textAlign='center';coinFace.ctx.textBaseline='middle';coinFace.ctx.fillStyle='#b17324';coinFace.ctx.font='bold 155px Georgia';coinFace.ctx.fillText('F',128,136);coinFace.texture.needsUpdate=true;
  for (const [x,y,z,r] of [[-2.62,.97,-.25,.47],[2.7,2.62,-1,.39],[-2.54,-1.38,.6,.30],[2.74,-1.64,-.32,.35]]) {
    const group=new THREE.Group();group.position.set(x,y,z);scene.add(group);
    const coin=cylinder(r,.10,gold,0,0,0,group);coin.rotation.x=Math.PI/2;
    const ring=new THREE.Mesh(new THREE.TorusGeometry(r*.85,.023,8,40),gold);ring.position.z=.062;group.add(ring);
    const face=new THREE.Mesh(new THREE.PlaneGeometry(r*1.4,r*1.4),new THREE.MeshBasicMaterial({map:coinFace.texture,transparent:true,toneMapped:false}));face.position.z=.068;group.add(face);
    group.rotation.set(.2,-.4,Math.sign(x)*.25);coins.push({group,y});
  }
  const sparkle=new THREE.Mesh(new THREE.OctahedronGeometry(.21),gold);sparkle.position.set(-1.7,2.84,.1);sparkle.scale.set(.65,1.35,.65);scene.add(sparkle);
  const handle=container.querySelector('#lever-handle');
  const cue=container.querySelector('#lever-cue');
  const cueText=container.querySelector('#lever-cue-text');
  const help=document.getElementById('lever-help');
  const gesture=createLeverGesture();
  const pullAngle=1.64;
  let busy=false,enabled=true,spinStart=0,spinResult=null,spinResolve=null,spinTimer=0,wonAt=-10000,spinFrom=0;
  let motion=!matchMedia('(prefers-reduced-motion: reduce)').matches,shown=true,raf=0,disposed=false;
  let returning=false,returnStart=0,returnFrom=0,handleTravel=90;
  const projected=new THREE.Vector3();
  const restPoint=new THREE.Vector3();
  const endPoint=new THREE.Vector3();
  let framingWidth=container.clientWidth,viewWidth=container.clientWidth,viewHeight=container.clientHeight,lastFrame=-Infinity;

  function setHelp(text){if(help.textContent!==text)help.textContent=text;}
  function requestFrame(){if(!raf&&!disposed)raf=requestAnimationFrame(frame);}
  function positionHandle(){
    const w=viewWidth,h=viewHeight;
    machine.updateMatrixWorld(true);
    knob.getWorldPosition(projected);projected.project(camera);
    const x=(projected.x*.5+.5)*w,y=(-projected.y*.5+.5)*h;
    handle.style.left=x+'px';handle.style.top=y+'px';
    const cueHalf=48,visibleLeft=(w-framingWidth)/2;
    const cueX=THREE.MathUtils.clamp(x,visibleLeft+cueHalf,visibleLeft+framingWidth-cueHalf);
    cue.style.left=cueX+'px';cue.style.top=(y-48)+'px';cue.style.setProperty('--arrow-offset',Math.max(-32,Math.min(32,x-cueX))+'px');
    restPoint.set(0,LEVER_LAYOUT.length,0).add(lever.position).applyMatrix4(machine.matrixWorld).project(camera);
    endPoint.set(0,LEVER_LAYOUT.length*Math.cos(pullAngle),LEVER_LAYOUT.length*Math.sin(pullAngle)).add(lever.position).applyMatrix4(machine.matrixWorld).project(camera);
    handleTravel=Math.max(54,(restPoint.y-endPoint.y)*h*.5);
  }
  function resize(){const {width,height}=container.getBoundingClientRect();if(!width||!height)return;viewWidth=width;viewHeight=height;renderer.setSize(width,height,false);camera.aspect=width/height;framingWidth=Math.min(width,container.parentElement.clientWidth,document.documentElement.clientWidth-24);const frame=slotCameraFrame(width,height,framingWidth);camera.position.set(frame.x,frame.y,frame.z);camera.lookAt(target);camera.updateProjectionMatrix();requestFrame();}
  const observer=new ResizeObserver(resize);observer.observe(container);resize();updatePot(demo?12.5:null);
  const intersectObserver=new IntersectionObserver(entries=>{shown=entries[0].isIntersecting;if(shown)requestFrame();},{threshold:.01});intersectObserver.observe(container);
  function returnLever(){returnFrom=lever.rotation.x;returnStart=performance.now();returning=motion;if(!motion)lever.rotation.x=0;handle.classList.remove('is-pulling','is-armed');cue.classList.remove('is-armed');cueText.textContent='PULL TO SPIN';requestFrame();}
  function releaseCapture(id){if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);}
  function onDown(e){
    if(!enabled||busy||e.button!==0||e.isPrimary===false)return;
    if(!gesture.begin(e.pointerId,e.clientY,handleTravel))return;
    e.preventDefault();handle.setPointerCapture(e.pointerId);returning=false;handle.classList.add('is-pulling');setHelp('Keep pulling down. A short pull spends nothing.');requestFrame();
  }
  function onMove(e){
    if(!gesture.active)return;
    e.preventDefault();const progress=gesture.move(e.pointerId,e.clientY);lever.rotation.x=progress*pullAngle;
    const armed=progress>=.85;handle.classList.toggle('is-armed',armed);cue.classList.toggle('is-armed',armed);cueText.textContent=armed?'RELEASE TO SPIN':'PULL TO SPIN';setHelp(armed?(demo?'Release to spin with 200,000 demo $SOLPOT.':'Release to request a 200,000 $SOLPOT spin in your wallet. Tokens burn after the result.'):'Keep pulling down. A short pull spends nothing.');requestFrame();
  }
  function onUp(e){
    if(!gesture.active)return;
    const commit=gesture.release(e.pointerId);releaseCapture(e.pointerId);
    if(gesture.active)return;
    handle.classList.remove('is-pulling','is-armed');cue.classList.remove('is-armed');
    if(commit&&enabled&&!busy){setHelp(demo?'Spinning… Your entry is locked.':'Confirm the entry in your wallet to spin.');onPlay();if(!busy)returnLever();}
    else {setHelp('Pull canceled. No tokens spent.');returnLever();}
  }
  function onCancel(e){if(!gesture.active)return;gesture.cancel(e.pointerId);if(!gesture.active){releaseCapture(e.pointerId);setHelp('Pull canceled. No tokens spent.');returnLever();}}
  function onKey(e){if((e.key==='Enter'||e.key===' ')&&!e.repeat){e.preventDefault();if(enabled&&!busy)onPlay();}}
  function onLostCapture(e){if(gesture.active)onCancel(e);}
  handle.addEventListener('pointerdown',onDown);handle.addEventListener('pointermove',onMove);handle.addEventListener('pointerup',onUp);handle.addEventListener('pointercancel',onCancel);handle.addEventListener('lostpointercapture',onLostCapture);handle.addEventListener('keydown',onKey);
  // Pointer clicks alone intentionally do nothing. Keyboard activation is above.
  handle.addEventListener('click',e=>e.preventDefault());
  function announceSymbols(){container.dataset.reels=symbols.map(n=>SYMBOLS[n].label).join(' · ');document.getElementById('reel-result').textContent='Reels: '+container.dataset.reels+'.';}
  function finishSpin(){if(!busy)return;clearTimeout(spinTimer);busy=false;lever.rotation.x=0;symbols.forEach((n,i)=>paintReel(i,n));announceSymbols();if(spinResult.won||spinResult.reward)wonAt=performance.now();const resolve=spinResolve;spinResolve=null;resolve?.();requestFrame();}
  function frame(now){raf=0;if(disposed||document.hidden||!shown)return;
    // Ambient decoration needs only 30 fps. Keep direct interaction and spins
    // at display refresh rate, and never render an offscreen/hidden cabinet.
    if(motion&&!busy&&!returning&&!gesture.active&&now-lastFrame<1000/30-0.5){requestFrame();return;}
    lastFrame=now;const time=now/1000;
    // The cabinet stays straight ahead; only world accents float.
    machine.rotation.set(0,0,0);machine.position.y=0;
    coins.forEach(({group,y},i)=>{group.position.y=y+(motion?Math.sin(time*.85+i)*.12:0);group.rotation.y=-.3+(motion?Math.sin(time*.5+i)*.33:0);});
    sparkle.rotation.y=motion?time*.23:0;
    if(returning&&!busy&&!gesture.active){const t=Math.min((now-returnStart)/420,1);lever.rotation.x=returnFrom*Math.pow(1-t,3);if(t===1)returning=false;}
    if(busy){const elapsed=now-spinStart;for(let i=0;i<3;i++){const stop=1150+i*380;if(elapsed<stop){const phase=elapsed*(.014-i*.001);paintReel(i,Math.floor(phase)%SYMBOLS.length,(phase%1)*300,true);}else paintReel(i,symbols[i]);}
      const pull=Math.min(elapsed/180,1);lever.rotation.x=elapsed<180?spinFrom+(pullAngle-spinFrom)*(1-Math.pow(1-pull,3)):pullAngle*Math.pow(1-Math.min((elapsed-180)/530,1),3);
      lights.forEach((l,i)=>{l.material.emissiveIntensity=(Math.floor(elapsed/150)+i)%3===0?1.7:.3;});
      if(elapsed>=2150)finishSpin();
    }else{const winGlow=now-wonAt<2600;lights.forEach(l=>{l.material.emissiveIntensity=winGlow?1.8:.4;});}
    positionHandle();renderer.render(scene,camera);
    if(!document.hidden&&shown&&(motion||busy||returning||gesture.active))requestFrame();
  }
  SYMBOLS.forEach((symbol,index)=>{if(!symbol.image)return;const img=new Image();img.onload=()=>{if(disposed)return;symbolImages[index]=img;if(index===0){const c=coinFace.ctx;c.clearRect(0,0,256,256);const scale=250/Math.max(img.naturalWidth,img.naturalHeight),w=img.naturalWidth*scale,h=img.naturalHeight*scale;c.drawImage(img,128-w/2,128-h/2,w,h);coinFace.texture.needsUpdate=true;}if(!busy)symbols.forEach((n,i)=>paintReel(i,n));requestFrame();};img.src=symbol.image;});
  const visibility=()=>{if(document.hidden&&gesture.active){gesture.cancel();returnLever();setHelp('Pull canceled. No tokens spent.');}if(!document.hidden)requestFrame();};document.addEventListener('visibilitychange',visibility);
  setStyle('signature');
  handle.hidden=false;cue.hidden=false;container.classList.add('scene-ready');announceSymbols();requestFrame();
  return {
    setStyle,
    setPot(pot,usd,quoteLabel,historical=false){updatePot(pot,usd,quoteLabel,historical);requestFrame();},
    setEnabled(value){enabled=value;handle.disabled=!value;cue.hidden=!value;handle.classList.toggle('is-disabled',!value);if(!value&&gesture.active){gesture.cancel();returnLever();}if(value&&!gesture.active&&!busy){setHelp('Pull down and release to spin for the jackpot. Entry: 200,000 $SOLPOT.');cueText.textContent='PULL TO SPIN';}requestFrame();},
    setMotion(value){motion=value;if(!value&&busy)finishSpin();requestFrame();},
    reset(){symbols=[4,1,0];symbols.forEach((n,i)=>paintReel(i,n));announceSymbols();gesture.cancel();lever.rotation.x=0;returning=false;setHelp('Pull down and release to spin for the jackpot. Entry: 200,000 $SOLPOT.');requestFrame();},
    spin(result){document.getElementById('reel-result').textContent='Reels spinning.';symbols=outcomeSymbols(result.number);spinResult=result;spinStart=performance.now();spinFrom=lever.rotation.x;returning=false;gesture.cancel();setHelp('Spinning… Your entry is locked.');if(!motion){symbols.forEach((n,i)=>paintReel(i,n));lever.rotation.x=0;announceSymbols();requestFrame();return Promise.resolve();}busy=true;requestFrame();return new Promise(resolve=>{spinResolve=resolve;spinTimer=setTimeout(finishSpin,2200);});},
    dispose(){clearTimeout(spinTimer);disposed=true;cancelAnimationFrame(raf);observer.disconnect();intersectObserver.disconnect();document.removeEventListener('visibilitychange',visibility);handle.removeEventListener('pointerdown',onDown);handle.removeEventListener('pointermove',onMove);handle.removeEventListener('pointerup',onUp);handle.removeEventListener('pointercancel',onCancel);handle.removeEventListener('lostpointercapture',onLostCapture);handle.removeEventListener('keydown',onKey);scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});reels.forEach(r=>r.texture.dispose());jackpot.texture.dispose();labels.texture.dispose();buttonText.texture.dispose();coinFace.texture.dispose();Object.values(bodyShapes).forEach(g=>g.dispose());environment.dispose();renderer.dispose();renderer.domElement.remove();spinResolve?.();}
  };
}
