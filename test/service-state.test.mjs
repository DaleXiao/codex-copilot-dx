import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithRequestContext } from '../src/request-context.mjs';
import { rememberResponseHistoryNode, materializeResponseHistory, exportResponseHistory, importResponseHistory, clearResponseHistoryForTests, responseHistoryStats } from '../src/response-history.mjs';
import { createImageReferenceStore } from '../src/image-references.mjs';

test('private handoff preserves opaque history, parent links and source namespaces without changing IDs', () => {
 clearResponseHistoryForTests();
 const context = { historyNamespace: 'source-a' };
 runWithRequestContext(context, () => {
  rememberResponseHistoryNode({ id:'resp-one',inputItems:[{role:'user',content:'synthetic'}],outputItems:[{type:'reasoning',encrypted_content:'synthetic-opaque'}],hasOpaque:true,routeAffinity:{origin:'github',profile:'source-a'} });
  rememberResponseHistoryNode({ id:'resp-two',parentId:'resp-one',inputItems:[{role:'user',content:'next'}],outputItems:[] });
 });
 const expected=runWithRequestContext(context,()=>materializeResponseHistory('resp-two'));
 const state=structuredClone(exportResponseHistory());clearResponseHistoryForTests();importResponseHistory(state);
 assert.deepEqual(runWithRequestContext(context,()=>materializeResponseHistory('resp-two')),expected);
 assert.throws(()=>runWithRequestContext({historyNamespace:'source-b'},()=>materializeResponseHistory('resp-two')),/not available/);
 clearResponseHistoryForTests();
});
test('malformed or cyclic state is refused before any history is published', () => {
 clearResponseHistoryForTests();
 rememberResponseHistoryNode({id:'resp-a',inputItems:[],outputItems:[]});const state=structuredClone(exportResponseHistory());clearResponseHistoryForTests();
 state.entries[0][1].parentId='resp-a';assert.throws(()=>importResponseHistory(state),/Cyclic/);assert.equal(responseHistoryStats().entries,0);
});
test('image IDs remain editable after a private cache handoff and stay provider scoped', () => {
 const config={endpoint:'https://example.test/images',model:'image-probe',protocol:'images',api_key:'synthetic-key'};
 const a=createImageReferenceStore(),id=a.remember(config,{mimeType:'image/png',data:Buffer.from('synthetic-image').toString('base64'),size:'1x1'});
 const b=createImageReferenceStore();b.importState(a.exportState());assert.deepEqual(b.resolve(config,id),a.resolve(config,id));
 assert.throws(()=>b.resolve({...config,api_key:'another-synthetic-key'},id),/unavailable/);
 assert.throws(()=>b.importState([['invalid','{}']]),/Invalid/);assert.ok(b.resolve(config,id));
});
