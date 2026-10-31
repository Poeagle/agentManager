import {describe,expect,it} from 'vitest';
import {decodeQuestionReply,encodeQuestionReply,questionAnswers} from '../src/lib/conversation-question-reply';
import type {ConversationMessage} from '../src/lib/api';
describe('native asynchronous answers',()=>{
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
