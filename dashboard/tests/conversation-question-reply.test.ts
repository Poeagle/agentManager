import {describe,expect,it} from 'vitest';
import {decodeQuestionReply,encodeQuestionReply,questionAnswers,pendingConversationQuestions} from '../src/lib/conversation-question-reply';
import type {ConversationMessage} from '../src/lib/api';
describe('native asynchronous answers',()=>{
  it('ignores a snapshot of question IDs without hiding later questions and supports partial answers',()=>{
    const group={id:'a',questions:[{id:'q1',title:'A',options:null},{id:'q2',title:'B',options:null}],timestamp:null};
    const later={id:'b',questions:[{id:'q3',title:'C',options:null}],timestamp:null};
    expect(pendingConversationQuestions([],[group,later],['q1','q2']).flatMap(m=>m.async_questions?.map(q=>q.id))).toEqual(['q3']);
    const reply={id:'reply',role:'user',text:'reply',timestamp:null,question_replies:[{question_id:'q1',question:'A',answer:'OK'}]} satisfies ConversationMessage;
    expect(pendingConversationQuestions([reply],[group]).flatMap(m=>m.async_questions?.map(q=>q.id))).toEqual(['q2']);
  });
  it('keeps questions across unrelated followups and recovers questions outside loaded history',()=>{
    const question={id:'message',role:'assistant',text:'去哪？',timestamp:'2026-01-01',async_questions:[{id:'q',title:'去哪？',options:null}]} satisfies ConversationMessage;
    const followup={id:'followup',role:'user',timestamp:'2026-01-02',text:'先做别的事情'} satisfies ConversationMessage;
    expect(pendingConversationQuestions([question,followup])).toEqual([question]);
    const groups=[{id:'native-call',questions:question.async_questions,timestamp:'2026-01-01'}];
    expect(pendingConversationQuestions([followup],groups)).toHaveLength(1);
    expect(pendingConversationQuestions([question,followup],groups)).toHaveLength(1);
    const answered={...followup,question_replies:[{question_id:'q',question:'去哪？',answer:'A'}]};
    expect(pendingConversationQuestions([question,answered],groups)).toEqual([]);
  });
  it('preserves the native question identity while presenting readable text',()=>{
    const replies=[{question_id:JSON.stringify(['request_user_input_async','call-test',0]),question:'去哪？',answer:'测试\n多行'}];
    const encoded=encodeQuestionReply(replies);expect(encoded).toContain('questionItemId');expect(decodeQuestionReply(encoded)).toEqual({answers:replies,text:'回复你的提问：\n1. 去哪？\n我的回答：测试\n多行'});
    for(const value of ['quoted '+encoded,encoded+' trailing','<send_user_message_question_reply>[]</send_user_message_question_reply>'])expect(decodeQuestionReply(value)).toBeUndefined();
  });
  it('finds native answers by identity and restores replies from the previous web version',()=>{
    const q={id:'message',role:'assistant',text:'去哪？',timestamp:null,async_questions:[{id:'native-q',title:'去哪？',options:['A','B']}]} satisfies ConversationMessage;
    expect(questionAnswers(q,[{id:'reply',role:'user',timestamp:null,text:'reply',question_replies:[{question_id:'native-q',question:'去哪？',answer:'测试'}]}])).toEqual(['测试']);
    expect(questionAnswers(q,[{id:'old',role:'user',timestamp:null,text:'回复你的提问：\n1. 去哪？\n我的回答：测试'}])).toEqual(['测试']);
    expect(questionAnswers(q,[{id:'other',role:'user',timestamp:null,text:'下一个任务'}])).toBeNull();
  });
});
