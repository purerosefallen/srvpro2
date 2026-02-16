import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('random_duel_score')
export class RandomDuelScore {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name!: string;

  @Index()
  @Column('int', { default: 0 })
  winCount = 0;

  @Index()
  @Column('int', { default: 0 })
  loseCount = 0;

  @Index()
  @Column('int', { default: 0 })
  fleeCount = 0;

  @Column('int', { default: 0 })
  winCombo = 0;

  win() {
    this.winCount += 1;
    this.winCombo += 1;
  }

  lose() {
    this.loseCount += 1;
    this.winCombo = 0;
  }

  flee() {
    this.fleeCount += 1;
    this.lose();
  }
}
