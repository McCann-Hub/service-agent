import assert from 'assert';
import { hello } from '../src/index';

describe('Array', function () {
  describe('#indexOf()', function () {
    it('should return -1 when the value is not present', function () {
      assert.equal([1, 2, 3].indexOf(4), -1);
    });
  });
});

describe('Main', function () {
  describe('#hello', function () {
    it('should return "hello world!" when no value is passed', function () {
      assert.equal(hello(), 'Hello world!');
    });
  });
});
