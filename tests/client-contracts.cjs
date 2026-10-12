const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function loadContracts(clientPath = path.resolve(__dirname, '../reference/client.js')) {
  const source = fs.readFileSync(clientPath, 'utf8');
  const start = /var M\s*,\s*R\s*,\s*L\s*;/.exec(source)?.index;
  const end = /const qc\s*=/.exec(source)?.index;
  if (start === undefined || end === undefined || end < start) throw new Error('Reference schema boundary missing.');
  const context = { i: (object,key,value) => object[key] = value };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end) + `;globalThis.contracts={
    me:bt({user:ca.extend({settings:sr,tutorialStep:ut().int(),tutorialSnoozed:pt(),createdAt:ht(),providers:xt(ht())}),wallet:sa,counters:wt(ht(),ft()),unread:bt({mailbox:ut().int(),gifts:ut().int(),friendRequests:ut().int(),hamletChat:ut().int(),stolen:ut().int().optional(),rewards:ut().int().optional(),latestReward:Va.nullable().optional(),materialRequests:ut().int().optional()}),account:rr}),
    profilePatch:bt({user:ca.extend({settings:sr,tutorialStep:ut().int(),tutorialSnoozed:pt(),createdAt:ht(),providers:xt(ht())})}),
    homeGet:fr,homePost:gr,map:dr,province:ur,
    storage:bt({storage:Ea,bag:xt(oa)}),
    shop:bt({tabs:bt({fields:mo,buildings:xt(fo),pens:xt(_o),animals:xt(vo),trees:xt(xo),decor:xt(bo),dogs:xt(yo),consumables:xt(wo),xu:xt(wt(ht(),ft()))})}),
    seeds:bt({seeds:xt(So)}),
    quests:bt({main:xt(ja),daily:xt(ja),dailyRerollXu:ut().int()}),
    achievements:bt({achievements:xt(Oa)}),titles:bt({active:ht().nullable(),catalog:xt(Fa)}),
    truck:bt({orders:xt(ro)}),boat:bt({boat:lo}),
    checkin:bt({streakDay:ut().int(),canClaimToday:pt(),rewards:xt(Ba)}),
    chests:bt({freeAvailable:pt(),extraCostXu:ut().int(),openedToday:ut().int(),odds:xt(Ua)}),
    mailbox:bt({items:xt(Na),count:ut().int(),max:ut().int()}),
    logs:ra(Va).extend({seenAt:ht().nullable().optional()}),
    events:bt({events:xt(Ol)}),flags:bt({flags:wt(ht(),pt())}),
    chat:bt({items:xt(il),nextCursor:ht().nullable(),disabled:pt()}),
    chatSummary:bt({global:al,province:al.nullable(),village:al.nullable(),hamlet:al.nullable(),hiddenUserIds:xt(ht()).optional()}),
    dm:bt({items:xt(cl),totalUnread:ut().int().min(0),disabled:pt()}),
    giftcode:bt({codes:xt(Ga)}),spotlight:kc,pass:Ec,
    ads:bt({enabled:pt(),usedToday:ut().int().nonnegative(),dailyCapTotal:ut().int().positive(),placements:xt(Oc),provider:jc.nullable(),providerConfig:wt(ht(),ft()).optional()}).passthrough(),
    affiliate:bt({links:xt(Bc)}),dog:Nr,
    homeChoiceRequest:bt({provinceId:ht(),change:pt().optional()}),
    seedBuyRequest:bt({cropId:ht(),qty:ut().int().min(1).max(999),currency:St(['gold','xu'])}),
  };`,context,{timeout:10000});
  return context.contracts;
}
module.exports = {loadContracts};
