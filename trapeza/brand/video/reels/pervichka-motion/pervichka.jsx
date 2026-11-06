const NAVY="#0A1230", NAVY2="#16204A", BLUE="#2E3A8C", GREEN="#35D07F", DGREEN="#0E9F58",
      RED="#FF6369", AMBER="#F5A524", MIST="#F2F5FB", MUTED="#A9B4D6", WHITE="#FFFFFF";
const W=1080, H=1920, F="Montserrat";

// появление: проявиться и приподняться
const enter=(at=0,dy=70,d=0.5)=>[
  {property:"opacity",from:0,to:1,at,duration:Math.min(0.35,d)},
  {property:"offsetY",from:dy,to:0,at,duration:d,easing:"house"}];
// «поп» с перескоком
const pop=(at=0)=>[
  {property:"opacity",from:0,to:1,at,duration:0.12},
  {property:"scale",keyframes:[{at,value:0.55,easing:"house"},{at:at+0.22,value:1.1,easing:"house"},{at:at+0.38,value:1}]}];
const fadeOut=(dur)=>({property:"opacity",keyframes:[{at:0,value:1},{at:dur-0.22,value:1},{at:dur,value:0}]});

const Txt=({x=0,y=0,w=W,h=120,size=80,weight=800,color=WHITE,align="center",anim,children,ls=0,lh})=>
  <text x={x} y={y} width={w} height={h} fontFamily={F} fontWeight={weight} fontSize={size} color={color} align={align} letterSpacing={ls} {...(lh?{lineHeight:lh}:{})} animate={anim}>{children}</text>;

// мягкие пятна света на фоне — как оранжевые шары в референсе
const Blobs=({colors,dur})=>colors.map((c,i)=>{
  const x=[-160,700,260][i%3], y=[200,1100,1500][i%3], s=[620,520,700][i%3];
  return <rect x={x} y={y} width={s} height={s} radius={s/2} fill={c} effects={[{kind:"layer-blur",params:{radius:140}}]}
    animate={[{property:"offsetX",keyframes:[{at:0,value:0,easing:"ease-in-out"},{at:dur/2,value:i%2?-90:90,easing:"ease-in-out"},{at:dur,value:0}]},
              {property:"offsetY",keyframes:[{at:0,value:0,easing:"ease-in-out"},{at:dur/2,value:i%2?70:-70,easing:"ease-in-out"},{at:dur,value:0}]}]}/>;
});

const Scene=({bg,dur,blobs,children})=>
  <frame width={W} height={H} layout="none" background={bg} animate={[fadeOut(dur)]}>
    {blobs?<Blobs colors={blobs} dur={dur}/>:null}
    {children}
  </frame>;

// «QR»: узор из квадратов с тремя угловыми метками (иллюстрация, не рабочий код)
const QR=({x,y,s=300})=>{
  const n=21,c=s/n; const cells=[]; let seed=7;
  const rnd=()=>{seed=(seed*9301+49297)%233280;return seed/233280;};
  const finder=(i,j)=>(i<7&&j<7)||(i<7&&j>=n-7)||(i>=n-7&&j<7);
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    if(finder(i,j))continue;
    if(rnd()>0.52)cells.push(<rect x={j*c} y={i*c} width={c} height={c} fill={NAVY}/>);
  }
  const mark=(i,j)=>[
    <rect x={j*c} y={i*c} width={7*c} height={7*c} fill={NAVY}/>,
    <rect x={(j+1)*c} y={(i+1)*c} width={5*c} height={5*c} fill={WHITE}/>,
    <rect x={(j+2)*c} y={(i+2)*c} width={3*c} height={3*c} fill={NAVY}/>];
  return <group x={x} y={y} width={s} height={s}>{cells}{mark(0,0)}{mark(0,n-7)}{mark(n-7,0)}</group>;
};

export default async ({ project }) => {
  const p = await project({ dir: "pervichka", size: `${W}x${H}`, fps: 30, background: NAVY });

  // ───────── 1. ХУК: счёт за 1 минуту ─────────
  { const d=3.6;
    p.compose(<Scene bg={NAVY} dur={d} blobs={[BLUE,DGREEN,BLUE]}>
      <Txt y={330} h={140} size={72} weight={700} color={MUTED} anim={enter(0.1)}>Счёт клиенту</Txt>
      <frame x={90} y={500} width={900} height={420} layout="column" align="center"
        motion={{timeline:{duration:2.4,easing:"ease-out",at:0.2,targets:[{target:"Sec",counter:{from:0,to:60,decimals:0,suffix:""}}]}}}>
        <frame name="Sec" width={900} height={400} layout="none">
          <text x={0} y={0} width={900} height={400} fontFamily={F} fontWeight={800} fontSize={380} color={WHITE} align="center">0</text>
        </frame>
      </frame>
      <Txt y={960} h={130} size={96} color={GREEN} anim={enter(1.9,50)}>секунд.</Txt>
      <rect x={290} y={1130} width={500} height={14} radius={7} fill={GREEN} animate={[{property:"scaleX",from:0,to:1,at:0.4,duration:2.2,easing:"ease-out"}]}/>
      <Txt y={1300} h={200} size={84} anim={pop(2.5)}>Первичка</Txt>
      <Txt y={1450} h={100} size={44} weight={700} color={MUTED} anim={enter(2.8,30)}>счета, акты и УПД в Телеграме</Txt>
    </Scene>,{at:0,dur:d,name:"hook"});
  }

  // ───────── 2. ГОЛОСОМ → ГОТОВЫЙ СЧЁТ С QR ─────────
  { const d=6;
    const bars=Array.from({length:21},(_,i)=>{
      let s=i*13+5; const keys=[];
      for(let k=0;k<=21;k++){ s=(s*9301+49297)%233280; keys.push({at:k*0.28,value:0.18+0.82*(s/233280),easing:"ease-in-out"}); }
      return <rect x={90+i*43} y={300} width={26} height={260} radius={13} fill={i%3===0?GREEN:WHITE}
        animate={[{property:"scaleY",keyframes:keys},{property:"opacity",keyframes:[{at:0,value:0},{at:0.2,value:1},{at:1.2,value:1},{at:1.6,value:0.28}]}]}/>;
    });
    p.compose(<Scene bg={NAVY2} dur={d} blobs={[BLUE,GREEN,BLUE]}>
      <Txt y={110} h={120} size={64} color={WHITE} anim={enter(0.05)}>Говоришь боту голосом</Txt>
      {bars}
      <rect x={110} y={660} width={860} height={190} radius={40} fill={WHITE} animate={enter(1.0,60)}/>
      <Txt x={150} y={700} w={780} h={140} size={46} weight={700} color={NAVY} align="left" anim={enter(1.1,60)}>«счёт Вектору на сорок пять тысяч»</Txt>
      <frame x={150} y={930} width={780} height={760} layout="none" motion={{enter:{from:{y:700,scale:0.9,opacity:0},duration:0.7,easing:"house"}}}>
        <rect x={0} y={0} width={780} height={760} radius={36} fill={WHITE} shadow={{y:30,blur:60,color:"#00000066"}}/>
        <Txt x={50} y={50} w={400} h={70} size={34} weight={800} color={BLUE} align="left">СЧЁТ № 1</Txt>
        <Txt x={430} y={52} w={300} h={60} size={26} weight={700} color={MUTED} align="right">ПРИМЕР</Txt>
        <Txt x={50} y={130} w={680} h={70} size={36} weight={700} color={NAVY} align="left">ООО «Вектор»</Txt>
        <rect x={50} y={225} width={680} height={4} fill={MIST}/>
        <Txt x={50} y={260} w={680} h={60} size={30} weight={700} color={MUTED} align="left">К оплате</Txt>
        <Txt x={50} y={310} w={680} h={140} size={100} weight={800} color={NAVY} align="left">45 000 ₽</Txt>
        <QR x={50} y={440} s={270}/>
        <Txt x={350} y={470} w={390} h={200} size={36} weight={800} color={DGREEN} align="left">Клиент платит, наведя камеру банка</Txt>
        <rect x={350} y={640} width={380} height={64} radius={32} fill={DGREEN}/>
        <Txt x={350} y={652} w={380} h={50} size={28} weight={800} color={WHITE}>QR для оплаты</Txt>
      </frame>
    </Scene>,{at:3.6,dur:d,name:"voice"});
  }

  // ───────── 3. ВСЕ ДОКУМЕНТЫ ─────────
  { const d=4.6;
    const chips=[["СЧЁТ",BLUE],["АКТ",DGREEN],["УПД","#7B3FE4"],["ТОРГ-12","#E0701F"],["ДОГОВОР",NAVY]];
    p.compose(<Scene bg={MIST} dur={d} blobs={["#C9D4FF","#BDEED3","#C9D4FF"]}>
      <Txt y={200} h={260} size={92} color={NAVY} anim={enter(0.05)}>Все документы</Txt>
      <Txt y={400} h={120} size={56} weight={700} color={BLUE} anim={enter(0.2,40)}>по нужной форме</Txt>
      {chips.map(([t,c],i)=>{
        const y=620+i*210, x=i%2?210:70, w=800;
        return <frame x={x} y={y} width={w} height={170} layout="none" animate={[
            {property:"opacity",from:0,to:1,at:0.4+i*0.22,duration:0.15},
            {property:"offsetX",from:i%2?900:-900,to:0,at:0.4+i*0.22,duration:0.6,easing:"house"}]}>
          <rect x={0} y={0} width={w} height={170} radius={85} fill={c} shadow={{y:14,blur:30,color:"#0A123044"}}/>
          <Txt x={0} y={38} w={w} h={110} size={78} color={WHITE}>{t}</Txt>
        </frame>;})}
      <Txt y={1700} h={100} size={40} weight={700} color={NAVY} anim={enter(1.8,30)}>УПД — по постановлению № 1137</Txt>
    </Scene>,{at:9.6,dur:d,name:"docs"});
  }

  // ───────── 4. КТО ДОЛЖЕН ─────────
  { const d=5.4;
    const rows=[["ООО «Вектор»","45 000 ₽",RED],["ИП Орлов","12 500 ₽",AMBER],["ООО «Заря»","8 200 ₽",AMBER]];
    p.compose(<Scene bg={NAVY} dur={d} blobs={[RED,BLUE,BLUE]}>
      <Txt y={170} h={130} size={80} anim={enter(0.05)}>Кто должен —</Txt>
      <Txt y={290} h={130} size={80} color={GREEN} anim={enter(0.2)}>видно сразу</Txt>
      {rows.map(([n,s,c],i)=>
        <frame x={80} y={560+i*230} width={920} height={190} layout="none" animate={[
            {property:"opacity",from:0,to:1,at:0.5+i*0.25,duration:0.15},
            {property:"offsetX",from:1000,to:0,at:0.5+i*0.25,duration:0.55,easing:"house"}]}>
          <rect x={0} y={0} width={920} height={190} radius={36} fill={NAVY2} strokeColor="#2B3A7A" strokeWidth={3}/>
          <rect x={0} y={0} width={18} height={190} radius={9} fill={c}/>
          <Txt x={60} y={60} w={500} h={80} size={44} weight={700} align="left">{n}</Txt>
          <Txt x={480} y={50} w={400} h={100} size={58} weight={800} color={c} align="right">{s}</Txt>
        </frame>)}
      <Txt y={1290} h={70} size={30} weight={700} color={MUTED} anim={enter(1.3,20)}>ПРИМЕР</Txt>
      <frame x={190} y={1390} width={700} height={150} layout="none" animate={pop(2.2)}>
        <rect x={0} y={0} width={700} height={150} radius={75} fill={GREEN} shadow={{y:0,blur:50,color:"#35D07F99"}}/>
        <Txt x={0} y={36} w={700} h={90} size={54} color={NAVY}>Напомнить клиенту</Txt>
      </frame>
      <Txt y={1620} h={130} size={44} weight={700} color={MUTED} anim={enter(2.6,30)}>Бот подскажет, кому напомнить.</Txt>
      <Txt y={1700} h={110} size={44} weight={700} color={MUTED} anim={enter(2.8,30)}>Письмо уйдёт только по вашей кнопке.</Txt>
    </Scene>,{at:14.2,dur:d,name:"debts"});
  }

  // ───────── 5. ОСНОВАНИЕ ЗАПОМИНАЕТСЯ ─────────
  { const d=5;
    p.compose(<Scene bg={MIST} dur={d} blobs={["#C9D4FF","#BDEED3","#C9D4FF"]}>
      <Txt y={170} h={260} size={78} color={NAVY} anim={enter(0.05)}>Основание накладной</Txt>
      <Txt y={290} h={140} size={78} color={BLUE} anim={enter(0.2)}>запоминается</Txt>
      <rect x={90} y={560} width={900} height={230} radius={36} fill={WHITE} shadow={{y:14,blur:40,color:"#0A123033"}} animate={enter(0.5,60)}/>
      <Txt x={130} y={590} w={820} h={60} size={28} weight={700} color={MUTED} align="left" anim={enter(0.6,40)}>Основание</Txt>
      <Txt x={130} y={650} w={820} h={110} size={50} weight={800} color={NAVY} align="left" anim={enter(0.7,40)}>Договор № 7 от 01.03</Txt>
      {[0,1,2].map(i=>
        <frame x={150+i*270} y={900} width={240} height={240} layout="none" animate={pop(1.2+i*0.45)}>
          <rect x={0} y={0} width={240} height={240} radius={120} fill={i<2?BLUE:DGREEN}/>
          {i<2?<Txt x={0} y={52} w={240} h={150} size={130} color={WHITE}>{String(i+1)}</Txt>
            :<path d="M62 124 L106 166 L184 78" width={240} height={240} stroke={{color:WHITE,width:26,cap:"round"}}/>}
        </frame>)}
      <Txt y={1220} h={100} size={44} weight={700} color={NAVY} anim={enter(1.3,30)}>Написали три раза одно и то же —</Txt>
      <Txt y={1340} h={160} size={64} color={DGREEN} anim={enter(2.8,40)}>дальше подставится само</Txt>
      <Txt y={1540} h={90} size={38} weight={700} color="#4A5578" anim={enter(3.3,30)}>отдельно для каждого клиента</Txt>
    </Scene>,{at:19.6,dur:d,name:"basis"});
  }

  // ───────── 6. ЦЕНА ─────────
  { const d=4.4;
    p.compose(<Scene bg={DGREEN} dur={d} blobs={[GREEN,BLUE,GREEN]}>
      <Txt y={230} h={120} size={60} weight={700} color={WHITE} anim={enter(0.05)}>Всё это — за</Txt>
      <frame x={90} y={400} width={900} height={440} layout="column" align="center"
        motion={{timeline:{duration:1.6,easing:"ease-out",at:0.3,targets:[{target:"Price",counter:{from:0,to:390,decimals:0,suffix:" ₽"}}]}}}>
        <frame name="Price" width={900} height={420} layout="none">
          <text x={0} y={0} width={900} height={420} fontFamily={F} fontWeight={800} fontSize={250} color={WHITE} align="center">0 ₽</text>
        </frame>
      </frame>
      <Txt y={900} h={110} size={64} weight={700} color={WHITE} anim={enter(1.2,40)}>в месяц, без ограничений</Txt>
      <rect x={140} y={1180} width={800} height={190} radius={95} fill={NAVY} animate={pop(2.0)}/>
      <Txt y={1215} h={140} size={50} color={WHITE} anim={pop(2.1)}>5 документов в месяц</Txt>
      <Txt y={1285} h={80} size={50} color={GREEN} anim={pop(2.2)}>бесплатно</Txt>
    </Scene>,{at:24.6,dur:d,name:"price"});
  }

  // ───────── 7. ПРИЗЫВ ─────────
  { const d=3.6;
    p.compose(<Scene bg={NAVY} dur={d} blobs={[BLUE,GREEN,BLUE]}>
      <Txt y={420} h={140} size={72} weight={700} color={MUTED} anim={enter(0.05)}>Напиши боту</Txt>
      <Txt y={560} h={260} size={190} color={GREEN} anim={pop(0.3)}>СЧЁТ</Txt>
      <rect x={110} y={980} width={860} height={160} radius={80} fill={WHITE} animate={[...pop(0.9),
        {property:"scale",keyframes:[{at:1.6,value:1,easing:"ease-in-out"},{at:2.0,value:1.05,easing:"ease-in-out"},{at:2.4,value:1}]}]}/>
      <Txt y={1022} h={100} size={56} color={NAVY} anim={pop(1.0)}>@pervichka_app_bot</Txt>
      <Txt y={1300} h={140} size={100} anim={enter(1.3,40)}>Первичка</Txt>
      <Txt y={1440} h={80} size={38} weight={700} color={MUTED} anim={enter(1.5,30)}>Без бухгалтера. Без 1С.</Txt>
    </Scene>,{at:29,dur:d,name:"cta"});
  }

  await p.render("pervichka/renders/pervichka-motion.mp4");
};
