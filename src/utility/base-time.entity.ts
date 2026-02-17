import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class BaseTimeEntity {
  @CreateDateColumn({
    type: 'timestamp',
  })
  createTime!: Date;

  @UpdateDateColumn({
    type: 'timestamp',
  })
  updateTime!: Date;

  @DeleteDateColumn({
    type: 'timestamp',
    nullable: true,
  })
  deleteTime?: Date;
}
