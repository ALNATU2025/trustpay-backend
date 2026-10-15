'use strict';
const models = {
  User: require('./User'),
  Otp: require('./Otp'),
  Txn: require('./Txn'),
  Idempotency: require('./Idempotency'),
  Recipient: require('./Recipient'),
  Config: require('./Config'),
  Card: require('./Card'),
  Terminal: require('./Terminal'),
  TerminalRequest: require('./TerminalRequest'),
  PosPayment: require('./PosPayment'),
  Settlement: require('./Settlement'),
  PosCharge: require('./PosCharge'),
  Ticket: require('./Ticket'),
  Message: require('./Message'),
  Approval: require('./Approval'),
};
module.exports = models;
