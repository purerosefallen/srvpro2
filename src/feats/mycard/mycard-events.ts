import { MycardUser } from './mycard-user';

export class OnMycardAuthenticated {
  constructor(public readonly user: MycardUser) {}
}
