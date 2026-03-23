const mongoose = require('mongoose')

const aiCreditHistorySchema = new mongoose.Schema({
  type: { type: String, enum: ['consume', 'recharge', 'reward', 'refund'], required: true },
  amount: { type: Number, required: true },
  balance: { type: Number, required: true },
  operation: { type: String, required: true },
  relatedId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
})

const aiCreditSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  balance: { type: Number, default: 1000 },
  totalConsumed: { type: Number, default: 0 },
  totalRecharged: { type: Number, default: 0 },
  history: [aiCreditHistorySchema]
}, {
  timestamps: true
})

aiCreditSchema.methods.consume = async function (amount, operation, relatedId = '') {
  if (this.balance < amount) {
    throw new Error('积分余额不足')
  }
  this.balance -= amount
  this.totalConsumed += amount
  this.history.push({
    type: 'consume',
    amount: -amount,
    balance: this.balance,
    operation,
    relatedId
  })
  if (this.history.length > 300) {
    this.history = this.history.slice(-300)
  }
  return this.save()
}

aiCreditSchema.methods.recharge = async function (amount, operation, relatedId = '') {
  this.balance += amount
  this.totalRecharged += amount
  this.history.push({
    type: 'recharge',
    amount,
    balance: this.balance,
    operation,
    relatedId
  })
  if (this.history.length > 300) {
    this.history = this.history.slice(-300)
  }
  return this.save()
}

aiCreditSchema.methods.refund = async function (amount, operation, relatedId = '') {
  this.balance += amount
  this.history.push({
    type: 'refund',
    amount,
    balance: this.balance,
    operation,
    relatedId
  })
  if (this.history.length > 300) {
    this.history = this.history.slice(-300)
  }
  return this.save()
}

aiCreditSchema.statics.getOrCreate = async function (userId) {
  let credit = await this.findOne({ userId })
  if (!credit) {
    credit = await this.create({ userId, balance: 1000 })
  }
  return credit
}

module.exports = mongoose.model('AiCredit', aiCreditSchema)
