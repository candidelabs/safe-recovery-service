import supertest from 'supertest';
import {app} from '../src/index';

describe('auth', ()=>{
    it('should return a 404 if wrong path', async ()=>{
        await supertest(app).get('/v1/auth/wrong/').expect(404);
    });
});
