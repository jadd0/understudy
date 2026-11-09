export class InsufficientFunds extends Error {
  constructor() {
    super("insufficient funds");
    this.name = "InsufficientFunds";
  }
}

export class CapReached extends Error {
  constructor() {
    super("daily spend cap reached");
    this.name = "CapReached";
  }
}

export class OfferUnavailable extends Error {
  constructor() {
    super("offer unavailable");
    this.name = "OfferUnavailable";
  }
}

export class NotYourOffer extends Error {
  constructor() {
    super("offer belongs to another fan");
    this.name = "NotYourOffer";
  }
}

export class InvalidAmount extends Error {
  constructor() {
    super("amount must be a positive whole number of cents");
    this.name = "InvalidAmount";
  }
}

export class NotAllowed extends Error {
  constructor() {
    super("this account may not spend");
    this.name = "NotAllowed";
  }
}

export class NotFound extends Error {
  constructor() {
    super("not found");
    this.name = "NotFound";
  }
}

export class ConfigInvalid extends Error {
  constructor(public readonly key: string) {
    super(`config row invalid: ${key}`);
    this.name = "ConfigInvalid";
  }
}
