import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithRequestContext } from '../src/request-context.mjs';
import { rememberResponseHistoryNode, materializeResponseHistory, exportResponseHistory, importResponseHistory, clearResponseHistoryForTests, responseHistoryStats } from '../src/response-history.mjs';

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
