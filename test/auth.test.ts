import supertest from 'supertest';
import {app} from '../src/index';

describe('auth', ()=>{
    it('should return a 404 if wrong path', async ()=>{
        await supertest(app).get('/v1/auth/wrong/').expect(404);
    });
    describe('auth', ()=>{
        it('should fail with 400 to register if wrong message format', async ()=>{
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  statement: "invalid format",
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "failed custom validation"
                )
            });
        });
        
        it('should fail with 400 to register if wrong message', async ()=>{
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  //statement: "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
                  statement: "invalid message",
                  chainId: 11155111,
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "invalid message"
                )
            });
        });

        it('should fail with 403 to register if invalid signature', async ()=>{
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using user@example.com (via email)",
                  chainId: 11155111,
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });
        });
    });
});
